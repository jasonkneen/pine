import fs from "node:fs";
import path from "node:path";
import { checkAgentId, checkColor } from "./admin.ts";
import { type AgentConfig, loadConfig, PINE_ROOT, type PineConfig, purposeFrom, WORKSPACE_FILES } from "./config.ts";
import { errText } from "./util.ts";

/** The built-in tools an agent can be given. */
export const AGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface NewAgent {
	id: string;
	/**
	 * Who it is and how it works: its AGENTS.md, in its workspace, which it can change itself from then on.
	 * Its first paragraph says what it is for: other agents read that when they decide whom to hand work to (`purposeOf`).
	 */
	instructions: string;
	model?: string;
	tools?: string[];
	/** Its color in the Pine app, `#rrggbb`; left out or "none" for no color. */
	color?: string;
}

/**
 * Create an agent while the daemon runs: its folder with agent.json, and a workspace with its
 * instructions (AGENTS.md) and the other files it keeps itself, as they come with a new home. The files are written first and then read back through the normal loader, so a new
 * agent is checked exactly like one that was there at start; if it does not pass, the folder is
 * taken away again. Nothing but these few lines goes into its agent.json.
 */
/** What is wrong with a proposed agent, as an error; nothing is written. Returns the cleaned-up values. */
export function checkNewAgent(cfg: PineConfig, spec: NewAgent): { purpose: string; tools: string[]; color?: string } {
	checkAgentId(cfg, spec.id);
	if (!spec.instructions.trim()) throw new Error("an agent needs instructions: who it is and how it works");
	const purpose = purposeFrom(spec.instructions);
	if (!purpose) throw new Error("the instructions need a first paragraph that says what the agent is for, for example \"You are books. You keep the household's accounts.\": other agents read it when they decide whom to hand work to");
	const tools = spec.tools ?? AGENT_TOOLS;
	const unknown = tools.filter((t) => !AGENT_TOOLS.includes(t));
	if (unknown.length) throw new Error(`unknown tool${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}. An agent can have: ${AGENT_TOOLS.join(", ")}`);
	const color = spec.color === undefined ? undefined : checkColor(spec.color);
	return { purpose, tools, color };
}

/**
 * The instructions of a new agent from what a command or an older client gives: what it is for
 * (`description`, as `pine agent add --description` and `POST /agents` take it) becomes their
 * first paragraph, which is where pine reads it from (`purposeOf`).
 */
export function instructionsWith(id: string, description: unknown, instructions: unknown): string {
	const what = typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
	const how = typeof instructions === "string" ? instructions.trim() : "";
	if (!what) return how;
	return how ? `${what}\n\n${how}` : `You are ${id}. ${what.replace(/\.?$/, ".")}`;
}

export function createAgent(cfg: PineConfig, spec: NewAgent): AgentConfig {
	const { tools, color } = checkNewAgent(cfg, spec);
	const dir = path.join(cfg.home, "agents", spec.id);
	fs.mkdirSync(path.join(dir, "workspace"), { recursive: true, mode: 0o700 });
	try {
		fs.writeFileSync(path.join(dir, "agent.json"), `${JSON.stringify({ ...(color ? { color } : {}), ...(spec.model ? { model: spec.model } : {}), tools }, null, 2)}\n`, { mode: 0o600 });
		fs.writeFileSync(path.join(dir, "workspace", "AGENTS.md"), `${spec.instructions.trim()}\n`, { mode: 0o600 });
		// The rest starts as in a new home: empty files, which the agent fills when it has something for them.
		for (const name of WORKSPACE_FILES.slice(1)) {
			const stub = path.join(PINE_ROOT, "examples", "home", "agents", "main", "workspace", name);
			if (fs.existsSync(stub)) fs.copyFileSync(stub, path.join(dir, "workspace", name)), fs.chmodSync(path.join(dir, "workspace", name), 0o600);
		}
		const made = loadConfig(cfg.home).agents[spec.id];
		if (!made) throw new Error("the new agent was not found after writing it");
		cfg.agents[spec.id] = made;
		return made;
	} catch (e) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw new Error(`the agent could not be created: ${errText(e)}`);
	}
}
