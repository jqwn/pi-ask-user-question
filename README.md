# @jqwn/pi-ask-user-question

A [Pi](https://pi.dev) extension that lets the model pause mid-task and ask rich questions in the terminal UI.

It registers an `AskUserQuestion` tool with support for:

- 1-4 questions in a single dialog
- 2-4 options per question
- short headers for multi-question navigation
- option descriptions
- optional option previews for code/config/mockup comparisons
- single-select or multi-select questions
- automatic `Other` custom-text answers

## Installation

```bash
pi install npm:@jqwn/pi-ask-user-question
```

Project-local install:

```bash
pi install -l npm:@jqwn/pi-ask-user-question
```

Try from a local checkout:

```bash
pi -e /path/to/pi-ask-user-question
```

## Usage

Once installed, `AskUserQuestion` is available to the model automatically. Ask Pi to clarify before choosing an approach, for example:

```text
Before implementing, use AskUserQuestion to ask me which database to use: Postgres, MySQL, or SQLite.
```

The extension also provides a manual demo command:

```text
/ask-user-question-demo
```

## Tool schema

```ts
{
  questions: [
    {
      question: string,
      header: string,
      options: [
        {
          label: string,
          description: string,
          preview?: string
        }
      ],
      multiSelect?: boolean
    }
  ],
  metadata?: {
    source?: string
  }
}
```

## Notes for model behavior

- Use `AskUserQuestion` when a user preference, requirement, or decision is needed before proceeding.
- Ask specific questions with 2-4 concrete choices.
- Do not include an `Other` option; the TUI adds it automatically.
- Use `multiSelect` only when multiple options can be chosen together.
- Use previews only for concrete artifacts users need to compare, like snippets, configs, or ASCII mockups.

## Publishing

This package includes the `pi-package` keyword and `pi.extensions` manifest so it can be discovered by Pi's package gallery after being published to npm.

## License

MIT
