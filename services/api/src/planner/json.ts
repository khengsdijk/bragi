/** Parses a model reply that should be JSON but may be wrapped in a Markdown fence. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}
