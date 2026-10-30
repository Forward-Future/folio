import { fromMarkdown } from "mdast-util-from-markdown";

interface MarkdownNode {
  type: string;
  position?: { start: { offset?: number; column: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

// Use Markdown's own source spans: indentation and backticks alone cannot tell
// a list continuation from code, or an inline code span from a fenced block.
export function normalizeMathDelimiters(text: string): string {
  const code: { start: number; end: number }[] = [];
  const containers: { start: number; end: number; prefix: string; quotes: number }[] = [];
  const visit = (node: MarkdownNode, prefix = "", quotes = 0) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (["code", "inlineCode", "html", "definition"].includes(node.type)) {
        code.push({ start, end });
        return;
      }
      if (node.type === "blockquote" || node.type === "listItem") {
        const marker = node.type === "blockquote" ? "> " : " ".repeat(/^([-+*]|\d+[.)])[ \t]+/.exec(text.slice(start))?.[0].length ?? 2);
        prefix += " ".repeat(Math.max(0, node.position!.start.column - 1 - prefix.length)) + marker;
        if (node.type === "blockquote") quotes++;
        containers.push({ start, end, prefix, quotes });
      }
    }
    node.children?.forEach((child) => visit(child, prefix, quotes));
  };
  visit(fromMarkdown(text));

  let result = "";
  let i = 0;
  let codeIndex = 0;
  const closingDelimiter = (start: number, delimiter: string, multiline: boolean) => {
    for (let j = start; j < text.length; j++) {
      if (!multiline && text[j] === "\n") return -1;
      if (text.startsWith(delimiter, j)) return j;
      if (text[j] === "\\") j++;
    }
    return -1;
  };

  while (i < text.length) {
    while (code[codeIndex]?.end <= i) codeIndex++;
    if (code[codeIndex]?.start <= i) {
      const end = code[codeIndex++].end;
      result += text.slice(i, end);
      i = end;
      continue;
    }

    // URLs and link destinations may legitimately contain dollar signs.
    if (/^https?:\/\//.test(text.slice(i))) {
      const url = /^[^\s<>]+/.exec(text.slice(i))![0];
      result += url;
      i += url.length;
      continue;
    }
    if (text[i] === "(" && text[i - 1] === "]") {
      let end = i + 1;
      let depth = 1;
      while (end < text.length && depth) {
        if (text[end] === "\\") end++;
        else if (text[end] === "(") depth++;
        else if (text[end] === ")") depth--;
        end++;
      }
      result += text.slice(i, end);
      i = end;
      continue;
    }

    if (text[i] === "\\") {
      const open = text.slice(i, i + 2);
      if (open === "\\(" || open === "\\[") {
        const display = open === "\\[";
        const end = closingDelimiter(i + 2, display ? "\\]" : "\\)", true);
        const context = containers.findLast((c) => c.start <= i && i < c.end);
        const prefix = context?.prefix ?? "";
        const quotePrefix = new RegExp(`^[ \\t]*(?:>[ \\t]*){${context?.quotes ?? 0}}`);
        const stripQuotes = (source: string) => source.split("\n").map((line, n) => n && context?.quotes ? line.replace(quotePrefix, "") : line).join("\n");
        if (end >= 0) {
          const math = stripQuotes(text.slice(i + 2, end)).trim();
          result += display
            ? `\n${prefix}$$\n${prefix}${math.replace(/\n/g, `\n${prefix}`)}\n${prefix}$$\n${prefix}`
            : `$$${math.replace(/\s*\n\s*/g, " ")}$$`;
          i = end + 2;
          continue;
        }
        // Keep partial streamed equations literal instead of parsing their lines as Markdown.
        const pending = stripQuotes(text.slice(i));
        const longestTicks = Math.max(0, ...[...pending.matchAll(/`+/g)].map((m) => m[0].length));
        const ticks = "`".repeat(Math.max(display ? 3 : 1, longestTicks + 1));
        result += display
          ? `\n${prefix}${ticks}tex\n${prefix}${pending.replace(/\n/g, `\n${prefix}`)}\n${prefix}${ticks}\n${prefix}`
          : `${ticks} ${pending.replace(/\s*\n\s*/g, " ")} ${ticks}`;
        break;
      }
      result += text.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (text.startsWith("$$", i)) {
      const end = closingDelimiter(i + 2, "$$", true);
      const next = end < 0 ? text.length : end + 2;
      result += text.slice(i, next);
      i = next;
      continue;
    }

    if (text[i] === "$" && !/\s/.test(text[i + 1] ?? " ")) {
      const end = closingDelimiter(i + 1, "$", false);
      // A closing dollar cannot touch a price: '$5 and $10' is prose.
      if (end > i + 1 && !/\s/.test(text[end - 1]) && !/[\d$]/.test(text[end + 1] ?? "")) {
        result += `$$${text.slice(i + 1, end)}$$`;
        i = end + 1;
        continue;
      }
    }

    result += text[i++];
  }
  return result;
}
