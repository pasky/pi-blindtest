import { createReadStream, readFileSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import {
	createAssistantMessageEventStream,
	streamSimpleAnthropic,
	streamSimpleAzureOpenAIResponses,
	streamSimpleBedrock,
	streamSimpleGoogle,
	streamSimpleGoogleGeminiCli,
	streamSimpleGoogleVertex,
	streamSimpleOpenAICodexResponses,
	streamSimpleOpenAICompletions,
	streamSimpleOpenAIResponses,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type ImageContent,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const BLIND_PROVIDER = "blindtest";
const BLIND_MODEL_ID = "blind";

const ASSIGNMENT_ENTRY_TYPE = "pi-blindtest-assignment";
const RATING_ENTRY_TYPE = "pi-blindtest-rating";

const MIN_RATING = 1;
const MAX_RATING = 5;
const RATING_OPTIONS = ["1", "2", "3", "4", "5"] as const;

function expandUserPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function getAgentDir(): string {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	if (fromEnv) return expandUserPath(fromEnv);
	return join(homedir(), ".pi", "agent");
}

const GLOBAL_CONFIG_PATH = join(getAgentDir(), "pi-blindtest.json");
const GLOBAL_SETTINGS_PATH = join(getAgentDir(), "settings.json");
const SESSIONS_ROOT_PATH = join(getAgentDir(), "sessions");
const RATING_ENTRY_MARKER = `"customType":"${RATING_ENTRY_TYPE}"`;

type HiddenModelRef = {
	provider: string;
	modelId: string;
};

type AssignmentEntryData = HiddenModelRef & {
	createdAt: number;
};

type RatingEntryData = HiddenModelRef & {
	rating: number;
	note?: string;
	createdAt: number;
};

type ModelRatingSummary = HiddenModelRef & {
	count: number;
	average: number;
};

type BlindtestConfig = {
	models?: string[];
};

type RatingsScanResult = {
	ratings: RatingEntryData[];
	sessionFilesWithRatings: number;
	scanStrategy: "ripgrep" | "stream";
};

let activeSessionFile: string | undefined;
let activeAssignment: HiddenModelRef | undefined;
let activeModelRegistry: ExtensionContext["modelRegistry"] | undefined;
let enforcingBlindModel = false;

function modelKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	} else {
		console.log(message);
	}
}

function renderRatingsOutput(pi: ExtensionAPI, ctx: ExtensionContext, lines: string[]): void {
	const content = [`Blindtest ratings`, "", ...lines].join("\n");

	if (ctx.hasUI) {
		pi.sendMessage({
			customType: "pi-blindtest-ratings",
			content,
			display: true,
		});
		return;
	}

	console.log(content);
}

function parseModelRef(value: string): HiddenModelRef | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	const separator = trimmed.indexOf("/");
	if (separator <= 0 || separator >= trimmed.length - 1) return undefined;

	return {
		provider: trimmed.slice(0, separator),
		modelId: trimmed.slice(separator + 1),
	};
}

function uniqueModelRefs(models: HiddenModelRef[]): HiddenModelRef[] {
	const deduped = new Map<string, HiddenModelRef>();
	for (const model of models) {
		deduped.set(modelKey(model.provider, model.modelId), model);
	}
	return Array.from(deduped.values());
}

function readConfigFile(path: string): BlindtestConfig | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const models = Array.isArray(parsed.models) ? parsed.models.filter((item): item is string => typeof item === "string") : undefined;
		return { models };
	} catch {
		return undefined;
	}
}

function loadConfig(cwd: string): BlindtestConfig {
	const globalConfig = readConfigFile(GLOBAL_CONFIG_PATH) ?? {};
	const projectConfig = readConfigFile(join(cwd, ".pi", "blindtest.json")) ?? {};

	return {
		models: projectConfig.models ?? globalConfig.models,
	};
}

function readEnabledModelsFromSettings(path: string): string[] | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (!Array.isArray(parsed.enabledModels)) return undefined;
		return parsed.enabledModels.filter((item): item is string => typeof item === "string");
	} catch {
		return undefined;
	}
}

function loadEnabledModelRefs(cwd: string): HiddenModelRef[] {
	const globalEnabled = readEnabledModelsFromSettings(GLOBAL_SETTINGS_PATH);
	const projectEnabled = readEnabledModelsFromSettings(join(cwd, ".pi", "settings.json"));
	const selected = projectEnabled ?? globalEnabled;
	if (!selected || selected.length === 0) return [];

	const refs: HiddenModelRef[] = [];
	for (const rawRef of selected) {
		const parsed = parseModelRef(rawRef);
		if (parsed) refs.push(parsed);
	}
	return uniqueModelRefs(refs);
}

function resolveCandidatePool(ctx: ExtensionContext, config: BlindtestConfig): HiddenModelRef[] {
	const availableModels = ctx.modelRegistry
		.getAvailable()
		.filter((model) => !(model.provider === BLIND_PROVIDER && model.id === BLIND_MODEL_ID));
	const availableByKey = new Map<string, HiddenModelRef>(
		availableModels.map((model) => [modelKey(model.provider, model.id), { provider: model.provider, modelId: model.id }]),
	);

	if (config.models && config.models.length > 0) {
		const configured: HiddenModelRef[] = [];
		for (const rawRef of config.models) {
			const parsed = parseModelRef(rawRef);
			if (!parsed) continue;
			const available = availableByKey.get(modelKey(parsed.provider, parsed.modelId));
			if (available) configured.push(available);
		}
		return uniqueModelRefs(configured);
	}

	const enabledModels = loadEnabledModelRefs(ctx.cwd);
	if (enabledModels.length > 0) {
		const enabledAvailable = enabledModels
			.map((model) => availableByKey.get(modelKey(model.provider, model.modelId)))
			.filter((model): model is HiddenModelRef => Boolean(model));
		if (enabledAvailable.length > 0) {
			return uniqueModelRefs(enabledAvailable);
		}
	}

	return uniqueModelRefs(
		availableModels.map((model) => ({
			provider: model.provider,
			modelId: model.id,
		})),
	);
}

function pickRandomModel(pool: HiddenModelRef[]): HiddenModelRef {
	const index = Math.floor(Math.random() * pool.length);
	return pool[index] ?? pool[0]!;
}

function readAssignmentFromSession(ctx: ExtensionContext): HiddenModelRef | undefined {
	let latest: HiddenModelRef | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom") continue;

		const customEntry = entry as { customType?: string; data?: unknown };
		if (customEntry.customType !== ASSIGNMENT_ENTRY_TYPE) continue;
		if (!customEntry.data || typeof customEntry.data !== "object") continue;

		const data = customEntry.data as Record<string, unknown>;
		const provider = typeof data.provider === "string" ? data.provider : undefined;
		const modelId = typeof data.modelId === "string" ? data.modelId : undefined;
		if (!provider || !modelId) continue;

		latest = { provider, modelId };
	}

	return latest;
}

function isModelAvailable(ctx: ExtensionContext, model: HiddenModelRef): boolean {
	return ctx.modelRegistry
		.getAvailable()
		.some((availableModel) => availableModel.provider === model.provider && availableModel.id === model.modelId);
}

async function ensureSessionAssignment(pi: ExtensionAPI, ctx: ExtensionContext): Promise<HiddenModelRef | undefined> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	activeModelRegistry = ctx.modelRegistry;

	if (activeSessionFile === sessionFile && activeAssignment) {
		return activeAssignment;
	}

	activeSessionFile = sessionFile;

	const existing = readAssignmentFromSession(ctx);
	if (existing) {
		activeAssignment = existing;
		if (!isModelAvailable(ctx, existing)) {
			notify(
				ctx,
				`Blindtest keeps this session's assigned model (${modelKey(existing.provider, existing.modelId)}), but it is currently unavailable.`,
				"warning",
			);
		}
		return activeAssignment;
	}

	const pool = resolveCandidatePool(ctx, loadConfig(ctx.cwd));
	if (pool.length === 0) {
		activeAssignment = undefined;
		notify(
			ctx,
			`Blindtest has no usable models. Configure ${GLOBAL_CONFIG_PATH} or .pi/blindtest.json with available provider/model entries.`,
			"error",
		);
		return undefined;
	}

	const selected = pickRandomModel(pool);
	activeAssignment = selected;

	const assignmentData: AssignmentEntryData = {
		provider: selected.provider,
		modelId: selected.modelId,
		createdAt: Date.now(),
	};
	pi.appendEntry(ASSIGNMENT_ENTRY_TYPE, assignmentData);

	notify(ctx, `Blindtest picked a random model from a pool of ${pool.length}.`, "info");
	return activeAssignment;
}

function buildErrorMessage(model: Model<Api>, reason: "error" | "aborted", message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: reason,
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function getStreamDelegate(
	api: Api,
): ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream) | undefined {
	switch (api) {
		case "anthropic-messages":
			return streamSimpleAnthropic as (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
		case "openai-completions":
			return streamSimpleOpenAICompletions as (
				model: Model<Api>,
				context: Context,
				options?: SimpleStreamOptions,
			) => AssistantMessageEventStream;
		case "openai-responses":
			return streamSimpleOpenAIResponses as (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
		case "openai-codex-responses":
			return streamSimpleOpenAICodexResponses as (
				model: Model<Api>,
				context: Context,
				options?: SimpleStreamOptions,
			) => AssistantMessageEventStream;
		case "azure-openai-responses":
			return streamSimpleAzureOpenAIResponses as (
				model: Model<Api>,
				context: Context,
				options?: SimpleStreamOptions,
			) => AssistantMessageEventStream;
		case "google-generative-ai":
			return streamSimpleGoogle as (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
		case "google-gemini-cli":
			return streamSimpleGoogleGeminiCli as (
				model: Model<Api>,
				context: Context,
				options?: SimpleStreamOptions,
			) => AssistantMessageEventStream;
		case "google-vertex":
			return streamSimpleGoogleVertex as (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
		case "bedrock-converse-stream":
			return streamSimpleBedrock as (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
		default:
			return undefined;
	}
}

async function enforceBlindModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const blindModel = ctx.modelRegistry.find(BLIND_PROVIDER, BLIND_MODEL_ID);
	if (!blindModel) {
		notify(ctx, `Blindtest model ${BLIND_PROVIDER}/${BLIND_MODEL_ID} is not available.`, "error");
		return;
	}

	if (ctx.model?.provider === BLIND_PROVIDER && ctx.model.id === BLIND_MODEL_ID) {
		return;
	}

	enforcingBlindModel = true;
	try {
		const ok = await pi.setModel(blindModel);
		if (!ok) {
			notify(ctx, `Failed to activate ${BLIND_PROVIDER}/${BLIND_MODEL_ID}.`, "error");
		}
	} finally {
		enforcingBlindModel = false;
	}
}

function parseRatingData(data: unknown): RatingEntryData | undefined {
	if (!data || typeof data !== "object") return undefined;

	const record = data as Record<string, unknown>;
	const provider = typeof record.provider === "string" ? record.provider : undefined;
	const modelId = typeof record.modelId === "string" ? record.modelId : undefined;
	const ratingRaw = typeof record.rating === "number" ? record.rating : Number(record.rating);

	if (!provider || !modelId || !Number.isFinite(ratingRaw)) return undefined;
	if (ratingRaw < MIN_RATING || ratingRaw > MAX_RATING) return undefined;

	return {
		provider,
		modelId,
		rating: ratingRaw,
		note: typeof record.note === "string" && record.note.trim().length > 0 ? record.note.trim() : undefined,
		createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
	};
}

function parseRatingEntryLine(line: string): RatingEntryData | undefined {
	if (!line.includes(RATING_ENTRY_TYPE)) return undefined;

	try {
		const parsed = JSON.parse(line) as {
			type?: unknown;
			customType?: unknown;
			data?: unknown;
		};
		if (parsed.type !== "custom") return undefined;
		if (parsed.customType !== RATING_ENTRY_TYPE) return undefined;
		return parseRatingData(parsed.data);
	} catch {
		return undefined;
	}
}

function readRatings(ctx: ExtensionContext): RatingEntryData[] {
	const ratings: RatingEntryData[] = [];

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom") continue;

		const customEntry = entry as { customType?: string; data?: unknown };
		if (customEntry.customType !== RATING_ENTRY_TYPE) continue;

		const rating = parseRatingData(customEntry.data);
		if (rating) ratings.push(rating);
	}

	return ratings;
}

function listSessionJsonlFiles(rootDir: string): string[] {
	const files: string[] = [];
	const stack = [rootDir];

	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;

		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const entryPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(entryPath);
			}
		}
	}

	return files;
}

function findSessionFilesWithRatingsUsingRipgrep(): string[] | undefined {
	try {
		const result = spawnSync("rg", ["-l", "--fixed-strings", "--glob", "*.jsonl", RATING_ENTRY_MARKER, SESSIONS_ROOT_PATH], {
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		});

		if (result.error) return undefined;
		if (result.status !== 0 && result.status !== 1) return undefined;

		return result.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		return undefined;
	}
}

async function sessionFileContainsMarker(path: string, marker: string): Promise<boolean> {
	try {
		const stream = createReadStream(path, { encoding: "utf8" });
		const overlapLength = Math.max(marker.length - 1, 0);
		let tail = "";

		for await (const chunk of stream) {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			const combined = tail + text;
			if (combined.includes(marker)) {
				stream.destroy();
				return true;
			}
			tail = overlapLength > 0 ? combined.slice(-overlapLength) : "";
		}
	} catch {
		return false;
	}

	return false;
}

async function findSessionFilesWithRatings(): Promise<{ files: string[]; strategy: "ripgrep" | "stream" }> {
	const fromRipgrep = findSessionFilesWithRatingsUsingRipgrep();
	if (fromRipgrep) {
		return {
			files: Array.from(new Set(fromRipgrep)),
			strategy: "ripgrep",
		};
	}

	const files = listSessionJsonlFiles(SESSIONS_ROOT_PATH);
	const matched: string[] = [];

	for (const file of files) {
		if (await sessionFileContainsMarker(file, RATING_ENTRY_MARKER)) {
			matched.push(file);
		}
	}

	return {
		files: matched,
		strategy: "stream",
	};
}

async function readRatingsFromSessionFile(path: string): Promise<RatingEntryData[]> {
	const ratings: RatingEntryData[] = [];

	try {
		const lineReader = createInterface({
			input: createReadStream(path, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		for await (const line of lineReader) {
			if (!line.includes(RATING_ENTRY_TYPE)) continue;

			const rating = parseRatingEntryLine(line);
			if (rating) ratings.push(rating);
		}
	} catch {
		return ratings;
	}

	return ratings;
}

async function readRatingsFromAllSessions(): Promise<RatingsScanResult> {
	const { files, strategy } = await findSessionFilesWithRatings();
	const ratings: RatingEntryData[] = [];

	for (const file of files) {
		const fileRatings = await readRatingsFromSessionFile(file);
		ratings.push(...fileRatings);
	}

	return {
		ratings,
		sessionFilesWithRatings: files.length,
		scanStrategy: strategy,
	};
}

function summarizeByModel(ratings: RatingEntryData[]): ModelRatingSummary[] {
	const byModel = new Map<string, { provider: string; modelId: string; sum: number; count: number }>();

	for (const rating of ratings) {
		const key = modelKey(rating.provider, rating.modelId);
		const existing = byModel.get(key);
		if (existing) {
			existing.sum += rating.rating;
			existing.count += 1;
		} else {
			byModel.set(key, {
				provider: rating.provider,
				modelId: rating.modelId,
				sum: rating.rating,
				count: 1,
			});
		}
	}

	return Array.from(byModel.values())
		.map((value) => ({
			provider: value.provider,
			modelId: value.modelId,
			count: value.count,
			average: value.sum / value.count,
		}))
		.sort((a, b) => {
			if (b.average !== a.average) return b.average - a.average;
			if (b.count !== a.count) return b.count - a.count;
			return modelKey(a.provider, a.modelId).localeCompare(modelKey(b.provider, b.modelId));
		});
}

async function promptForRating(args: string, ctx: ExtensionContext): Promise<{ rating: number; note?: string } | undefined> {
	const trimmedArgs = args.trim();

	if (!trimmedArgs) {
		if (!ctx.hasUI) {
			notify(ctx, `Usage: /rate <${MIN_RATING}-${MAX_RATING}> [optional note]`, "warning");
			return undefined;
		}

		const selected = await ctx.ui.select("Rate current model", [...RATING_OPTIONS]);
		if (!selected) return undefined;

		const rating = Number(selected);
		if (!Number.isFinite(rating)) return undefined;

		const noteValue = await ctx.ui.input("Optional note", "short rationale");
		const note = noteValue && noteValue.trim().length > 0 ? noteValue.trim() : undefined;
		return { rating, note };
	}

	const [ratingToken, ...noteParts] = trimmedArgs.split(/\s+/);
	const rating = Number(ratingToken);
	if (!Number.isFinite(rating) || rating < MIN_RATING || rating > MAX_RATING) {
		notify(ctx, `Rating must be a number between ${MIN_RATING} and ${MAX_RATING}.`, "error");
		return undefined;
	}

	const note = noteParts.join(" ").trim();
	return { rating, note: note.length > 0 ? note : undefined };
}

function resolveRatingTarget(
	ctx: ExtensionContext,
	assignment: HiddenModelRef | undefined,
): { target: HiddenModelRef | undefined; usesHiddenModel: boolean } {
	const currentModel = ctx.model;
	if (!currentModel) {
		return { target: assignment, usesHiddenModel: true };
	}

	const usesHiddenModel = currentModel.provider === BLIND_PROVIDER && currentModel.id === BLIND_MODEL_ID;
	if (usesHiddenModel) {
		return { target: assignment, usesHiddenModel: true };
	}

	return {
		target: { provider: currentModel.provider, modelId: currentModel.id },
		usesHiddenModel: false,
	};
}

type ReplayableUserMessageContent = string | (TextContent | ImageContent)[];

function isReplayableUserContentBlock(value: unknown): value is TextContent | ImageContent {
	if (!value || typeof value !== "object") return false;

	const block = value as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
	if (block.type === "text") {
		return typeof block.text === "string";
	}
	if (block.type === "image") {
		return typeof block.data === "string" && typeof block.mimeType === "string";
	}

	return false;
}

function readFirstUserMessageContent(ctx: ExtensionContext): ReplayableUserMessageContent | undefined {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message") continue;

		const message = entry.message as { role?: unknown; content?: unknown };
		if (message.role !== "user") continue;

		if (typeof message.content === "string") {
			return message.content.length > 0 ? message.content : undefined;
		}

		if (Array.isArray(message.content)) {
			const content = message.content.filter(isReplayableUserContentBlock);
			return content.length > 0 ? content : undefined;
		}

		return undefined;
	}

	return undefined;
}

export default function blindtestExtension(pi: ExtensionAPI) {
	const streamBlindProvider = (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();

		(async () => {
			try {
				if (!activeModelRegistry) {
					throw new Error("Blindtest model registry is not initialized yet.");
				}
				if (!activeAssignment) {
					throw new Error("No hidden model is assigned to this session yet.");
				}

				const targetModel = activeModelRegistry.find(activeAssignment.provider, activeAssignment.modelId);
				if (!targetModel) {
					throw new Error(`Assigned model ${modelKey(activeAssignment.provider, activeAssignment.modelId)} is unavailable.`);
				}

				const apiKey = await activeModelRegistry.getApiKey(targetModel);
				if (!apiKey) {
					throw new Error(`No API key configured for ${modelKey(targetModel.provider, targetModel.id)}.`);
				}

				const delegate = getStreamDelegate(targetModel.api);
				if (!delegate) {
					throw new Error(`Unsupported API for assigned model: ${targetModel.api}`);
				}

				const innerStream = delegate(targetModel, context, { ...options, apiKey });
				for await (const event of innerStream) {
					stream.push(event);
				}
				stream.end();
			} catch (error) {
				const reason: "error" | "aborted" = options?.signal?.aborted ? "aborted" : "error";
				const message = error instanceof Error ? error.message : String(error);
				stream.push({
					type: "error",
					reason,
					error: buildErrorMessage(model, reason, message),
				});
				stream.end();
			}
		})();

		return stream;
	};

	pi.registerProvider(BLIND_PROVIDER, {
		baseUrl: "https://blindtest.invalid",
		apiKey: "blindtest",
		api: "blindtest-router",
		models: [
			{
				id: BLIND_MODEL_ID,
				name: "Blind",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
		streamSimple: streamBlindProvider,
	});

	const initializeBlindSession = async (ctx: ExtensionContext, activateBlindModel: boolean) => {
		if (ctx.hasUI) {
			ctx.ui.setFooter(undefined);
		}
		await ensureSessionAssignment(pi, ctx);
		if (activateBlindModel) {
			await enforceBlindModel(pi, ctx);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const isFreshSession = ctx.sessionManager.getEntries().length === 0;
		await initializeBlindSession(ctx, isFreshSession);
	});

	pi.on("session_switch", async (event, ctx) => {
		const activateBlindModel = event.reason === "new";
		await initializeBlindSession(ctx, activateBlindModel);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await ensureSessionAssignment(pi, ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		activeModelRegistry = ctx.modelRegistry;
		if (enforcingBlindModel) return;
	});

	pi.registerCommand("another-model", {
		description: "Start a new session with a different hidden model and replay the first user prompt",
		handler: async (_args, ctx) => {
			const parentSession = ctx.sessionManager.getSessionFile();
			const firstUserMessage = readFirstUserMessageContent(ctx);
			const previousAssignment = readAssignmentFromSession(ctx);

			const pool = resolveCandidatePool(ctx, loadConfig(ctx.cwd));
			if (pool.length === 0) {
				notify(
					ctx,
					`Blindtest has no usable models. Configure ${GLOBAL_CONFIG_PATH} or .pi/blindtest.json with available provider/model entries.`,
					"error",
				);
				return;
			}

			const candidates = previousAssignment
				? pool.filter(
						(model) =>
							modelKey(model.provider, model.modelId) !==
							modelKey(previousAssignment.provider, previousAssignment.modelId),
				  )
				: pool;

			if (previousAssignment && candidates.length === 0) {
				notify(ctx, "Blindtest cannot pick another model because the pool has only one candidate.", "warning");
				return;
			}

			const selected = pickRandomModel(candidates);
			const assignmentData: AssignmentEntryData = {
				provider: selected.provider,
				modelId: selected.modelId,
				createdAt: Date.now(),
			};

			const result = await ctx.newSession({
				parentSession,
				setup: async (sessionManager) => {
					sessionManager.appendCustomEntry(ASSIGNMENT_ENTRY_TYPE, assignmentData);
				},
			});
			if (result.cancelled) return;

			if (!firstUserMessage) {
				notify(ctx, "Started a new blindtest session, but no first user message was found to replay.", "warning");
				return;
			}

			pi.sendUserMessage(firstUserMessage);
		},
	});

	pi.registerCommand("rate", {
		description: `Rate current model (${MIN_RATING}-${MAX_RATING}) for this session`,
		handler: async (args, ctx) => {
			const assignment = await ensureSessionAssignment(pi, ctx);
			const { target, usesHiddenModel } = resolveRatingTarget(ctx, assignment);
			if (!target) {
				notify(ctx, "No model available to rate.", "warning");
				return;
			}

			const input = await promptForRating(args, ctx);
			if (!input) return;

			const ratingData: RatingEntryData = {
				provider: target.provider,
				modelId: target.modelId,
				rating: input.rating,
				note: input.note,
				createdAt: Date.now(),
			};
			pi.appendEntry(RATING_ENTRY_TYPE, ratingData);

			const sessionSummaries = summarizeByModel(readRatings(ctx));
			const sessionSummary = sessionSummaries.find(
				(summary) => summary.provider === target.provider && summary.modelId === target.modelId,
			);
			const sessionAvgText = sessionSummary ? sessionSummary.average.toFixed(2) : input.rating.toFixed(2);
			const sessionCountText = sessionSummary ? sessionSummary.count : 1;

			const globalScan = await readRatingsFromAllSessions();
			const globalSummary = summarizeByModel(globalScan.ratings).find(
				(summary) => summary.provider === target.provider && summary.modelId === target.modelId,
			);
			const globalSummaryText = globalSummary
				? `global avg ${globalSummary.average.toFixed(2)} (n=${globalSummary.count})`
				: undefined;

			if (usesHiddenModel) {
				const detailParts = [`session hidden model avg ${sessionAvgText} (n=${sessionCountText})`];
				if (globalSummaryText) detailParts.push(globalSummaryText);
				notify(ctx, `Saved ${input.rating}/${MAX_RATING}. ${detailParts.join("; ")}.`, "info");
			} else {
				const detailParts = [`session avg ${sessionAvgText} (n=${sessionCountText})`];
				if (globalSummaryText) detailParts.push(globalSummaryText);
				notify(
					ctx,
					`Saved ${input.rating}/${MAX_RATING} for ${modelKey(target.provider, target.modelId)} (${detailParts.join("; ")}).`,
					"info",
				);
			}
		},
	});

	pi.registerCommand("ratings", {
		description: "Show average rating and number of ratings per model across all sessions",
		handler: async (_args, ctx) => {
			const scan = await readRatingsFromAllSessions();
			const ratings = scan.ratings;
			if (ratings.length === 0) {
				renderRatingsOutput(pi, ctx, ["No ratings yet across saved sessions. Use /rate to score the current model."]);
				return;
			}

			const assignment = await ensureSessionAssignment(pi, ctx);
			const { target: currentTarget, usesHiddenModel } = resolveRatingTarget(ctx, assignment);
			const currentModelKey = currentTarget ? modelKey(currentTarget.provider, currentTarget.modelId) : undefined;

			const summaries = summarizeByModel(ratings);
			const overallAvg = ratings.reduce((sum, item) => sum + item.rating, 0) / ratings.length;
			const currentSummary = currentModelKey
				? summaries.find((summary) => modelKey(summary.provider, summary.modelId) === currentModelKey)
				: undefined;
			const strategyLabel = scan.scanStrategy === "ripgrep" ? "ripgrep prefilter" : "stream prefilter";

			const currentLabel = usesHiddenModel ? "Current hidden model" : "Current model";
			const lines = [
				currentSummary
					? `${currentLabel} avg ${currentSummary.average.toFixed(2)} (n=${currentSummary.count})`
					: `${currentLabel} has no ratings yet`,
				`Overall avg ${overallAvg.toFixed(2)} across ${ratings.length} ratings`,
				`Source: ${scan.sessionFilesWithRatings} session file${scan.sessionFilesWithRatings === 1 ? "" : "s"} (${strategyLabel})`,
				...summaries.map((summary) => {
					const key = modelKey(summary.provider, summary.modelId);
					const marker =
						key === currentModelKey ? (usesHiddenModel ? "  <- current hidden model" : "  <- current model") : "";
					return `${key}  avg ${summary.average.toFixed(2)}  n=${summary.count}${marker}`;
				}),
			];

			renderRatingsOutput(pi, ctx, lines);
		},
	});
}
