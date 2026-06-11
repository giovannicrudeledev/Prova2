/**
 * Session Stats Extension
 *
 * Footer che mostra:
 * - Progress bar basata sul contesto reale (% di contesto usato vs massimo del modello)
 * - Token input/output dell'ultima richiesta
 * - Cache read/write
 * - Costo per richiesta e totale sessione
 * - Modello e git branch
 *
 * La progress bar è automatica (contestuale) ma può essere sovrascritta manualmente.
 *
 * Commands:
 *   /progress              Show current session stats
 *   /progress set <n>      Manually override progress (0-100)
 *   /progress step <n>     Increment manually
 *   /progress reset        Back to auto (context-based) + reset task/turns
 *   /progress task <name>  Name the current task
 *   /progress bar          Toggle between bar styles
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// --- Types ---
type BarStyle = "filled" | "blocks" | "shades";
type Theme = {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
};

// --- State ---
let manualOverride = false;
let manualProgress = 0;
let currentTask = "";
let turnCount = 0;
let barStyle: BarStyle = "filled";

const BAR_CHARS: Record<BarStyle, { fill: string; empty: string }> = {
	filled: { fill: "█", empty: "░" },
	blocks: { fill: "■", empty: "□" },
	shades: { fill: "▓", empty: "░" },
};

// --- Helpers /---

function fmtNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return `${n}`;
}

function fmtCost(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.001) return `${(n * 1000).toFixed(1)}m¢`;
	if (n < 1) return `${n.toFixed(3)}¢`;
	return `$${n.toFixed(2)}`;
}

interface SessionStats {
	inputTotal: number;
	outputTotal: number;
	cacheReadTotal: number;
	cacheWriteTotal: number;
	costTotal: number;
	inputLast: number;
	outputLast: number;
	cacheReadLast: number;
	cacheWriteLast: number;
	costLast: number;
}

function computeStats(
	entries: readonly { type: string; message?: Record<string, unknown> }[],
): SessionStats {
	let inputTotal = 0,
		outputTotal = 0,
		cacheReadTotal = 0,
		cacheWriteTotal = 0,
		costTotal = 0;
	let lastInput = 0,
		lastOutput = 0,
		lastCacheRead = 0,
		lastCacheWrite = 0,
		lastCost = 0;

	for (const e of entries) {
		if (e.type === "message" && e.message?.role === "assistant" && e.message?.usage) {
			const u = e.message.usage as AssistantMessage["usage"];
			const input = u.input ?? 0;
			const output = u.output ?? 0;
			const cR = u.cacheRead ?? 0;
			const cW = u.cacheWrite ?? 0;
			const cost = u.cost?.total ?? 0;

			inputTotal += input;
			outputTotal += output;
			cacheReadTotal += cR;
			cacheWriteTotal += cW;
			costTotal += cost;

			lastInput = input;
			lastOutput = output;
			lastCacheRead = cR;
			lastCacheWrite = cW;
			lastCost = cost;
		}
	}

	return {
		inputTotal,
		outputTotal,
		cacheReadTotal,
		cacheWriteTotal,
		costTotal,
		inputLast: lastInput,
		outputLast: lastOutput,
		cacheReadLast: lastCacheRead,
		cacheWriteLast: lastCacheWrite,
		costLast: lastCost,
	};
}

// --- Render ---

function renderFooter(
	width: number,
	theme: Theme,
	stats: SessionStats,
	modelLabel: string,
	branch: string | null,
	progressValue: number,
): string[] {
	const chars = BAR_CHARS[barStyle];
	const percent = Math.max(0, Math.min(100, progressValue));
	const barWidth = Math.max(4, Math.min(15, Math.floor(width * 0.18)));
	const filled = Math.round((percent / 100) * barWidth);
	const empty = barWidth - filled;

	const fillColor =
		percent < 40 ? "accent" : percent < 70 ? "warning" : "success";
	const bar =
		theme.fg(fillColor, chars.fill.repeat(filled)) +
		theme.fg("dim", chars.empty.repeat(empty));
	const pctText = theme.fg(
		percent === 100 ? "success" : "dim",
		`${percent}%`,
	);
	const taskText = currentTask
		? theme.fg("muted", ` ${currentTask}`)
		: "";

	// Section 1: Progress bar + task
	const section1 = `${bar} ${pctText}${taskText}`;

	// Section 2: Token stats — LAST REQUEST only
	const lastReqIn = theme.fg("success", `in:${fmtNum(stats.inputLast)}`);
	const lastReqOut = theme.fg("warning", `out:${fmtNum(stats.outputLast)}`);
	const cache =
		stats.cacheReadLast > 0
			? theme.fg("dim", ` cache:${fmtNum(stats.cacheReadLast)}`)
			: "";
	const section2 = `req ${lastReqIn} ${lastReqOut}${cache}`;

	// Section 3: Cost — LAST REQUEST + SESSION TOTAL
	const reqCostLabel = theme.fg("dim", "req");
	const reqCostVal = theme.fg("accent", fmtCost(stats.costLast));
	const totCostLabel = theme.fg("dim", "tot");
	const totCostVal = theme.fg("accent", fmtCost(stats.costTotal));
	const section3 = `${reqCostLabel}:${reqCostVal} ${totCostLabel}:${totCostVal}`;

	// Section 4: Model + branch
	const modelStr = theme.fg("accent", modelLabel);
	const branchStr = branch ? theme.fg("dim", ` (${branch})`) : "";
	const section4 = `${modelStr}${branchStr}`;

	const sep = theme.fg("dim", " │ ");
	const fullLine = `${section1}${sep}${section2}${sep}${section3}${sep}${section4}`;

	if (visibleWidth(fullLine) <= width) {
		const pad = width - visibleWidth(fullLine);
		return [fullLine + " ".repeat(pad)];
	}

	return [truncateToWidth(fullLine, width)];
}

// --- Extension Entrypoint ---

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubBranch = footerData.onBranchChange(() =>
				tui.requestRender(),
			);

			return {
				dispose: unsubBranch,
				invalidate() {},
				render(width: number): string[] {
					const branch = footerData.getGitBranch();
					const allEntries = ctx.sessionManager.getBranch();
					const stats = computeStats(allEntries);

					// Determine progress: manual override or auto from context
					let progressValue: number;
					if (manualOverride) {
						progressValue = manualProgress;
					} else {
						const usage = ctx.getContextUsage();
						if (
							usage &&
							ctx.model?.contextWindow &&
							ctx.model.contextWindow > 0
						) {
							progressValue = Math.round(
								(usage.tokens / ctx.model.contextWindow) * 100,
							);
						} else {
							progressValue = 0;
						}
					}

					const modelLabel = ctx.model
						? `${ctx.model.provider}/${ctx.model.id}`
						: "no-model";

					return renderFooter(
						width,
						theme,
						stats,
						modelLabel,
						branch,
						progressValue,
					);
				},
			};
		});
	});

	pi.on("turn_start", async () => {
		turnCount++;
	});

	pi.on("model_select", async (_event, ctx) => {
		ctx.ui.notify(
			`Model: ${ctx.model?.provider}/${ctx.model?.id}`,
			"info",
		);
	});

	pi.registerCommand("progress", {
		description:
			"Show session stats. Usage: /progress [set <n>|step <n>|reset|task <name>|bar]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const cmd = parts[0]?.toLowerCase();

			if (!cmd) {
				// Show detailed summary in notification
				const entries = ctx.sessionManager.getBranch();
				const stats = computeStats(entries);
				const usage = ctx.getContextUsage();
				const pct =
					usage && ctx.model?.contextWindow
						? Math.round(
								(usage.tokens / ctx.model.contextWindow) * 100,
							)
						: "?";
				const modelInfo = ctx.model
					? `${ctx.model.provider}/${ctx.model.id}`
					: "no-model";
				ctx.ui.notify(
					`Context: ${pct}% | ` +
						`Tokens: ↑${fmtNum(stats.inputTotal)} in ↓${fmtNum(stats.outputTotal)} out ` +
						`| Cache: ↑${fmtNum(stats.cacheReadTotal)} read ↑${fmtNum(stats.cacheWriteTotal)} write ` +
						`| Total cost: ${fmtCost(stats.costTotal)} ` +
						`| Model: ${modelInfo} ` +
						`| Turns: ${turnCount} ` +
						`| Task: "${currentTask || "none"}"`,
					"info",
				);
				return;
			}

			switch (cmd) {
				case "set": {
					const val = parseInt(parts[1] ?? "", 10);
					if (isNaN(val) || val < 0 || val > 100) {
						ctx.ui.notify(
							"Usage: /progress set <0-100>",
							"error",
						);
						return;
					}
					manualOverride = true;
					manualProgress = val;
					ctx.ui.notify(`Progress set to ${val}% (manual)`, "info");
					break;
				}
				case "step": {
					const val = parseInt(parts[1] ?? "1", 10);
					if (isNaN(val) || val < 0) {
						ctx.ui.notify(
							"Usage: /progress step <n>",
							"error",
						);
						return;
					}
					manualOverride = true;
					const prev = manualProgress;
					manualProgress = Math.min(100, manualProgress + val);
					ctx.ui.notify(
						`Progress: ${prev}% → ${manualProgress}% (manual)`,
						"info",
					);
					break;
				}
				case "reset": {
					manualOverride = false;
					manualProgress = 0;
					turnCount = 0;
					currentTask = "";
					ctx.ui.notify(
						"Progress reset to auto (context-based)",
						"info",
					);
					break;
				}
				case "task": {
					const taskName = parts.slice(1).join(" ");
					if (!taskName) {
						currentTask = "";
						ctx.ui.notify("Task name cleared", "info");
					} else {
						currentTask = taskName;
						ctx.ui.notify(`Task set: "${taskName}"`, "info");
					}
					break;
				}
				case "bar": {
					const styles: BarStyle[] = ["filled", "blocks", "shades"];
					const idx = styles.indexOf(barStyle);
					barStyle = styles[(idx + 1) % styles.length];
					ctx.ui.notify(`Bar style: ${barStyle}`, "info");
					break;
				}
				default:
					ctx.ui.notify(
						"Usage: /progress [set <0-100>|step <n>|reset|task <name>|bar]",
						"error",
					);
			}
		},
	});
}
