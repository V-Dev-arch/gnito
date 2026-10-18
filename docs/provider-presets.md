# Provider preset references

Gnito keeps API credentials server-side and resolves model IDs from each configured provider’s live `GET /models` endpoint (or native Anthropic model-list route). Preset API roots are defaults, not endorsements, and providers may update their protocol or model availability independently.

The preset roots used by `src/shared/providerPresets.ts` are:

- OpenAI: `https://api.openai.com/v1` — [OpenAI API reference](https://platform.openai.com/docs/api-reference/models/list)
- Anthropic: `https://api.anthropic.com` — [Anthropic API overview](https://platform.claude.com/docs/en/api/overview)
- Google Gemini: `https://generativelanguage.googleapis.com/v1beta/openai` — [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- Groq: `https://api.groq.com/openai/v1` — [Groq OpenAI compatibility](https://console.groq.com/docs/openai)
- xAI: `https://api.x.ai/v1` — [xAI API reference](https://docs.x.ai/docs/api-reference)
- Moonshot/Kimi: `https://api.moonshot.ai/v1` — [Kimi API quickstart](https://platform.kimi.ai/docs/overview)
- Z.ai: `https://api.z.ai/api/paas/v4` — [Z.ai OpenAI Python SDK guide](https://docs.z.ai/guides/develop/openai/python)

A Manus API preset is intentionally not enabled yet. This server adapter currently handles synchronous OpenAI Chat Completions and Anthropic Messages requests; it does not implement Manus’s distinct asynchronous Responses/Tasks API. Adding an entry with the wrong protocol would appear configured while failing at runtime.

Custom providers use the OpenAI-compatible protocol and their own `/models` endpoint. Local endpoints may omit an API key. A custom URL is user-configured, so only add endpoints you trust.
