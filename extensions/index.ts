import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@mariozechner/pi-tui";
import { Type, type Static } from "typebox";

const TOOL_NAME = "AskUserQuestion";
const OTHER_LABEL = "Other";

const QuestionOptionSchema = Type.Object({
	label: Type.String({
		description: "The display text for this option. Keep it concise (1-5 words).",
	}),
	description: Type.String({
		description: "Short explanation of this option and its trade-offs.",
	}),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional markdown/plain-text preview shown when this option is focused. Use for code snippets, config examples, ASCII mockups, or concrete alternatives the user should visually compare.",
		}),
	),
});

const QuestionSchema = Type.Object({
	question: Type.String({
		description: "The complete question to ask the user. Be clear and specific.",
	}),
	header: Type.String({
		description: "Very short label shown in the tab/status area, e.g. 'Scope', 'Library', 'Approach'.",
	}),
	options: Type.Array(QuestionOptionSchema, {
		minItems: 2,
		maxItems: 4,
		description: "2-4 available choices. Do not include an 'Other' option; it is added automatically.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set true when the user may select more than one option.",
		}),
	),
});

const AskUserQuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "Questions to ask the user (1-4).",
	}),
	metadata: Type.Optional(
		Type.Object({
			source: Type.Optional(Type.String({ description: "Optional source tag for diagnostics." })),
		}),
	),
});

type AskUserQuestionParams = Static<typeof AskUserQuestionParams>;
type Question = Static<typeof QuestionSchema> & { multiSelect: boolean };
type QuestionOption = Static<typeof QuestionOptionSchema>;

type RenderOption = QuestionOption & { isOther?: boolean };

type AnswerState = {
	labels: string[];
	customText?: string;
	preview?: string;
};

type AskUserQuestionDetails = {
	questions: Question[];
	answers: Record<string, string>;
	annotations?: Record<string, { preview?: string }>;
	cancelled: boolean;
};

function validateQuestions(questions: Question[]): string | null {
	const questionTexts = questions.map((q) => q.question);
	if (new Set(questionTexts).size !== questionTexts.length) {
		return "Question texts must be unique.";
	}

	for (const question of questions) {
		const labels = question.options.map((option) => option.label);
		if (new Set(labels).size !== labels.length) {
			return `Option labels must be unique within question: ${question.question}`;
		}
		if (labels.some((label) => label.trim().toLowerCase() === OTHER_LABEL.toLowerCase())) {
			return `Do not include an '${OTHER_LABEL}' option; it is added automatically.`;
		}
	}

	return null;
}

function makeEditor(tui: TUI, theme: Theme): Editor {
	const editorTheme: EditorTheme = {
		borderColor: (s: string) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (s: string) => theme.fg("accent", s),
			selectedText: (s: string) => theme.fg("accent", s),
			description: (s: string) => theme.fg("muted", s),
			scrollInfo: (s: string) => theme.fg("dim", s),
			noMatch: (s: string) => theme.fg("warning", s),
		},
	};
	return new Editor(tui, editorTheme);
}

class AskUserQuestionComponent implements Component {
	private questions: Question[];
	private tui: TUI;
	private theme: Theme;
	private done: (result: AskUserQuestionDetails | null) => void;
	private currentQuestionIndex = 0;
	private currentOptionIndex = 0;
	private inputMode = false;
	private editor: Editor;
	private answers = new Map<string, AnswerState>();
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(questions: Question[], tui: TUI, theme: Theme, done: (result: AskUserQuestionDetails | null) => void) {
		this.questions = questions;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.editor = makeEditor(tui, theme);
		this.editor.onSubmit = (value) => this.submitCustomAnswer(value);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.inputMode) {
			if (matchesKey(data, Key.escape)) {
				this.inputMode = false;
				this.editor.setText("");
				this.refresh();
				return;
			}
			this.editor.handleInput(data);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(null);
			return;
		}

		if (this.questions.length > 1) {
			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				this.moveQuestion(1);
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				this.moveQuestion(-1);
				return;
			}
		}

		if (matchesKey(data, Key.up)) {
			this.currentOptionIndex = Math.max(0, this.currentOptionIndex - 1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.currentOptionIndex = Math.min(this.currentOptions().length - 1, this.currentOptionIndex + 1);
			this.refresh();
			return;
		}

		const question = this.currentQuestion();
		if (question.multiSelect && matchesKey(data, Key.space)) {
			this.toggleCurrentOption();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			if (question.multiSelect) {
				if (!this.answers.get(question.question)?.labels.length) {
					return;
				}
				this.advanceOrFinish();
				return;
			}

			this.selectCurrentOption();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const add = (line = "") => lines.push(truncateToWidth(line, width));
		const question = this.currentQuestion();
		const options = this.currentOptions();
		const currentAnswer = this.answers.get(question.question);

		add(this.theme.fg("accent", "─".repeat(width)));
		add(
			` ${this.theme.fg("accent", this.theme.bold("Ask User Question"))} ${this.theme.fg(
				"dim",
				`(${this.currentQuestionIndex + 1}/${this.questions.length})`,
			)}`,
		);

		if (this.questions.length > 1) {
			add(` ${this.renderTabs(width - 1)}`);
		}

		add();
		for (const line of wrapTextWithAnsi(this.theme.fg("text", question.question), Math.max(10, width - 2))) {
			add(` ${line}`);
		}
		add();

		for (let i = 0; i < options.length; i++) {
			const option = options[i];
			const focused = i === this.currentOptionIndex;
			const selected = currentAnswer?.labels.includes(option.label) ?? false;
			const selector = question.multiSelect ? (selected ? "[x]" : "[ ]") : `${i + 1}.`;
			const prefix = focused ? this.theme.fg("accent", "> ") : "  ";
			const labelColor = focused ? "accent" : selected ? "success" : "text";
			add(`${prefix}${this.theme.fg(labelColor, `${selector} ${option.label}`)}`);
			for (const line of wrapTextWithAnsi(this.theme.fg("muted", option.description), Math.max(10, width - 6))) {
				add(`     ${line}`);
			}
		}

		if (this.inputMode) {
			add();
			add(this.theme.fg("muted", " Custom answer:"));
			for (const line of this.editor.render(Math.max(10, width - 2))) {
				add(` ${line}`);
			}
		}

		const preview = options[this.currentOptionIndex]?.preview;
		if (preview && !question.multiSelect) {
			add();
			add(this.theme.fg("accent", " Preview"));
			for (const line of wrapTextWithAnsi(preview, Math.max(10, width - 2)).slice(0, 12)) {
				add(` ${this.theme.fg("dim", "│")} ${line}`);
			}
		}

		add();
		if (question.multiSelect) {
			add(this.theme.fg("dim", " Space toggle • Enter next/submit • Tab/←→ switch question • Esc cancel"));
		} else if (this.inputMode) {
			add(this.theme.fg("dim", " Enter submit custom answer • Esc back"));
		} else {
			add(this.theme.fg("dim", " ↑↓ navigate • Enter select • Tab/←→ switch question • Esc cancel"));
		}
		add(this.theme.fg("accent", "─".repeat(width)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private currentQuestion(): Question {
		return this.questions[this.currentQuestionIndex];
	}

	private currentOptions(): RenderOption[] {
		return [
			...this.currentQuestion().options,
			{ label: OTHER_LABEL, description: "Type a custom answer instead.", isOther: true },
		];
	}

	private moveQuestion(delta: number): void {
		this.currentQuestionIndex = (this.currentQuestionIndex + delta + this.questions.length) % this.questions.length;
		this.currentOptionIndex = 0;
		this.inputMode = false;
		this.editor.setText("");
		this.refresh();
	}

	private selectCurrentOption(): void {
		const option = this.currentOptions()[this.currentOptionIndex];
		if (option.isOther) {
			this.inputMode = true;
			this.editor.setText("");
			this.refresh();
			return;
		}

		this.answers.set(this.currentQuestion().question, {
			labels: [option.label],
			preview: option.preview,
		});
		this.advanceOrFinish();
	}

	private toggleCurrentOption(): void {
		const question = this.currentQuestion();
		const option = this.currentOptions()[this.currentOptionIndex];
		if (option.isOther) {
			this.inputMode = true;
			this.editor.setText(this.answers.get(question.question)?.customText ?? "");
			this.refresh();
			return;
		}

		const answer = this.answers.get(question.question) ?? { labels: [] };
		answer.labels = answer.labels.includes(option.label)
			? answer.labels.filter((label) => label !== option.label)
			: [...answer.labels, option.label];
		this.answers.set(question.question, answer);
		this.refresh();
	}

	private submitCustomAnswer(value: string): void {
		const trimmed = value.trim();
		if (!trimmed) {
			this.inputMode = false;
			this.editor.setText("");
			this.refresh();
			return;
		}

		const question = this.currentQuestion();
		if (question.multiSelect) {
			const answer = this.answers.get(question.question) ?? { labels: [] };
			answer.customText = trimmed;
			answer.labels = [...answer.labels.filter((label) => label !== OTHER_LABEL && label !== trimmed), trimmed];
			this.answers.set(question.question, answer);
			this.inputMode = false;
			this.editor.setText("");
			this.refresh();
			return;
		}

		this.answers.set(question.question, { labels: [trimmed], customText: trimmed });
		this.inputMode = false;
		this.editor.setText("");
		this.advanceOrFinish();
	}

	private advanceOrFinish(): void {
		const nextUnanswered = this.questions.findIndex((q, index) => index > this.currentQuestionIndex && !this.answers.has(q.question));
		if (nextUnanswered !== -1) {
			this.currentQuestionIndex = nextUnanswered;
			this.currentOptionIndex = 0;
			this.refresh();
			return;
		}

		const firstUnanswered = this.questions.findIndex((q) => !this.answers.has(q.question));
		if (firstUnanswered !== -1) {
			this.currentQuestionIndex = firstUnanswered;
			this.currentOptionIndex = 0;
			this.refresh();
			return;
		}

		const answers: Record<string, string> = {};
		const annotations: Record<string, { preview?: string }> = {};
		for (const question of this.questions) {
			const answer = this.answers.get(question.question)!;
			answers[question.question] = answer.labels.join(", ");
			if (answer.preview) {
				annotations[question.question] = { preview: answer.preview };
			}
		}

		this.done({
			questions: this.questions,
			answers,
			annotations: Object.keys(annotations).length ? annotations : undefined,
			cancelled: false,
		});
	}

	private renderTabs(maxWidth: number): string {
		const parts = this.questions.map((question, index) => {
			const answered = this.answers.has(question.question);
			const active = index === this.currentQuestionIndex;
			const marker = answered ? "●" : "○";
			const text = ` ${marker} ${question.header || `Q${index + 1}`} `;
			if (active) return this.theme.bg("selectedBg", this.theme.fg("text", text));
			return this.theme.fg(answered ? "success" : "muted", text);
		});
		return truncateToWidth(parts.join(" "), maxWidth);
	}
}

function detailsToText(details: AskUserQuestionDetails): string {
	if (details.cancelled) return "User cancelled the question dialog.";

	const lines = ["User answered the questions:"];
	for (const [question, answer] of Object.entries(details.answers)) {
		lines.push(`- ${question}: ${answer}`);
		const preview = details.annotations?.[question]?.preview;
		if (preview) {
			lines.push(`  Selected preview:\n${preview}`);
		}
	}
	return lines.join("\n");
}

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask User Question",
		description:
			"Ask the user one or more multiple-choice questions in an interactive TUI. Use to clarify requirements, gather preferences, or choose among implementation approaches.",
		promptSnippet: "Ask the user one or more TUI multiple-choice questions and return their answers.",
		promptGuidelines: [
			"Use AskUserQuestion when you need user preferences, clarification, or a decision before proceeding.",
			"AskUserQuestion questions should be specific and include 2-4 concrete options; do not include an Other option because it is added automatically.",
			"Use AskUserQuestion multiSelect only when multiple options can be chosen together.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions: Question[] = params.questions.map((question) => ({
				...question,
				header: question.header.trim().slice(0, 24) || "Question",
				multiSelect: question.multiSelect ?? false,
			}));

			const validationError = validateQuestions(questions);
			if (validationError) {
				return {
					content: [{ type: "text" as const, text: `Invalid AskUserQuestion input: ${validationError}` }],
					details: { questions, answers: {}, cancelled: true } satisfies AskUserQuestionDetails,
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text" as const, text: "Cannot ask the user: interactive TUI is not available." }],
					details: { questions, answers: {}, cancelled: true } satisfies AskUserQuestionDetails,
				};
			}

			const result = await ctx.ui.custom<AskUserQuestionDetails | null>((tui, theme, _keybindings, done) => {
				return new AskUserQuestionComponent(questions, tui, theme, done);
			});

			const details = result ?? ({ questions, answers: {}, cancelled: true } satisfies AskUserQuestionDetails);
			return {
				content: [{ type: "text" as const, text: detailsToText(details) }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const labels = questions.map((q: Partial<Question>) => q.header || q.question || "Question").join(", ");
			return new Text(
				theme.fg("toolTitle", theme.bold("AskUserQuestion ")) +
					theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`) +
					(labels ? theme.fg("dim", ` (${truncateToWidth(labels, 48)})`) : ""),
				0,
				0,
			);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserQuestionDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "User cancelled AskUserQuestion"), 0, 0);
			}

			const lines = Object.entries(details.answers).map(
				([question, answer]) => `${theme.fg("success", "✓")} ${theme.fg("muted", question)} → ${theme.fg("accent", answer)}`,
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("ask-user-question-demo", {
		description: "Open a demo AskUserQuestion dialog",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("ask-user-question-demo requires interactive mode", "error");
				return;
			}
			const questions: Question[] = [
				{
					question: "Which implementation style should the assistant use?",
					header: "Style",
					multiSelect: false,
					options: [
						{
							label: "Surgical",
							description: "Make the smallest focused change that solves the task.",
							preview: "Best for production bug fixes and refactors with low risk.",
						},
						{
							label: "Comprehensive",
							description: "Handle adjacent cleanup and polish while already in the code.",
							preview: "Best when you want a more complete improvement pass.",
						},
					],
				},
			];
			const result = await ctx.ui.custom<AskUserQuestionDetails | null>((tui, theme, _keybindings, done) => {
				return new AskUserQuestionComponent(questions, tui, theme, done);
			});
			if (result) ctx.ui.notify(detailsToText(result), "info");
		},
	});
}
