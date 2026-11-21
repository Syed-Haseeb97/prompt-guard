/**
 * Prompt template rendering.
 *
 * Supports `{{ variable }}` placeholders (with optional whitespace) and the
 * `{{ variable | default }}` fallback syntax. Unknown variables are left
 * untouched so that literal braces in a prompt survive rendering.
 */

export interface RenderResult {
  text: string;
  /** Variables that were referenced but not provided. */
  missing: string[];
  /** Variable names that were substituted. */
  used: string[];
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.-]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

/** Render a template with the given variables. */
export function renderTemplate(
  template: string,
  variables: Record<string, string | number | boolean> = {},
): RenderResult {
  const missing: string[] = [];
  const used: string[] = [];

  const text = template.replace(PLACEHOLDER, (match, rawName: string, fallback?: string) => {
    const name = rawName.trim();
    if (Object.prototype.hasOwnProperty.call(variables, name)) {
      used.push(name);
      const value = variables[name];
      return value === undefined || value === null ? '' : String(value);
    }
    if (fallback !== undefined) {
      used.push(name);
      return fallback;
    }
    if (!missing.includes(name)) missing.push(name);
    return match;
  });

  return { text, missing, used };
}

export { escapeRegExp } from '../utils/text.js';
