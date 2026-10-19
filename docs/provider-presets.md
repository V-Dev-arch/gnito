# Provider presets and brand assets

Gnito stores provider credentials server-side in its local encrypted vault. OpenAI-compatible providers use the selected provider’s model endpoint; Anthropic uses its native Messages/Models API. Manus uses its separate asynchronous Tasks API and is not a chat-completions endpoint.

## API presets

- OpenAI: `https://api.openai.com/v1` — [OpenAI API reference](https://platform.openai.com/docs/api-reference/models/list)
- Anthropic: `https://api.anthropic.com` — [Anthropic API overview](https://platform.claude.com/docs/en/api/overview)
- Google Gemini: `https://generativelanguage.googleapis.com/v1beta/openai` — [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- Groq: `https://api.groq.com/openai/v1` — [Groq OpenAI compatibility](https://console.groq.com/docs/openai)
- SpaceXAI (Grok): `https://api.x.ai/v1` — [xAI API reference](https://docs.x.ai/docs/api-reference)
- Moonshot (Kimi): `https://api.moonshot.ai/v1` — [Kimi API overview](https://platform.kimi.ai/docs/overview)
- Z.ai: `https://api.z.ai/api/paas/v4` — [Z.ai OpenAI SDK guide](https://docs.z.ai/guides/develop/openai/python)
- Manus: `https://api.manus.ai` — [Manus Tasks API](https://open.manus.ai/docs/v2/introduction)

Custom providers use the OpenAI-compatible protocol and their own `/models` endpoint. Local endpoints may omit an API key. A custom URL is user-configured, so only add endpoints you trust.

## Manus adapter

Gnito’s Manus preset uses the documented v2 API with the `x-manus-api-key` header. Model/profile choices are the stable `lite`, `standard`, and `max` agent profiles. Gnito creates a private task, polls `task.detail`, and reads events from `task.listMessages`. The UI displays actual Manus status changes and preserves the task URL in the response. The local Stop action attempts to stop the remote task. Manus tasks execute on Manus infrastructure; they cannot use Gnito’s Docker workspace or local MCP connectors.

The remote task is polled for up to three minutes per chat request. If still running, Gnito returns the task link and leaves the remote task running. A stopped task is treated as complete only when the API reports `has_running_background_jobs: false`.

## Provider marks

- OpenAI SVG is bundled as a local vector asset.
- Anthropic, Gemini and Moonshot SVGs are bundled from the [Simple Icons catalog](https://github.com/simple-icons/simple-icons).
- Groq’s local SVG uses the Groq entry in the [Iconify Logos collection](https://icon-sets.iconify.design/logos/groq/).
- Manus uses the official icon from its [brand page](https://manus.im/brand).
- SpaceXAI’s logo is sourced from [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:SpaceXAI_logo.svg), which identifies the vector mark as sourced from spacex.ai and as a simple geometric/text logo; its trademark remains SpaceXAI’s.
- Z.ai’s logo is sourced from [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Z.ai_(company_logo).svg), which identifies z.ai as the source and likewise notes that the mark may be protected as a trademark.

Marks identify the configured service only; Gnito is not endorsed by these providers. Their use remains subject to each owner’s current brand rules.
