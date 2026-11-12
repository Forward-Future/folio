import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import { normalizeMathDelimiters } from "./chatMath";
import "katex/dist/katex.min.css";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  data?: { hProperties: { "data-folio-page": string; "data-folio-file"?: string } };
}

// Citations spell file names the way the model did; match them against the names Folio knows,
// case-insensitively and with or without the .pdf ending.
const citationKey = (name: string) => name.trim().replace(/\.pdf$/i, "").toLowerCase();

// Transform only prose text, so page references never alter code, maths or links.
function remarkPageReferences(files?: string[]) {
  const known = files ? new Map(files.map((name) => [citationKey(name), name])) : null;
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || ["link", "linkReference", "code", "inlineCode", "math", "inlineMath"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const parts: MarkdownNode[] = [];
        // Plain page references like (p. 12), and file citations like (Report.pdf, p. 12).
        const pattern = /\((?:([^,()]+),\s*)?((?:p|pp|page|pages)\.?\s*(\d+)(?:[–-]\d+)?)\)/gi;
        let last = 0;
        for (const match of child.value.matchAll(pattern)) {
          const cited = match[1]?.trim();
          let file: string | undefined;
          if (cited !== undefined && known) {
            file = known.get(citationKey(cited));
            // A file Folio doesn't have open can't be navigated to, so the citation stays text.
            if (file === undefined) continue;
          }
          if (match.index! > last) parts.push({ type: "text", value: child.value.slice(last, match.index) });
          parts.push({ type: "link", url: `#folio-page-${match[3]}`, data: { hProperties: file === undefined ? { "data-folio-page": match[3] } : { "data-folio-page": match[3], "data-folio-file": file } }, children: [{ type: "text", value: match[0] }] });
          last = match.index! + match[0].length;
        }
        if (last < child.value.length) parts.push({ type: "text", value: child.value.slice(last) });
        return parts;
      });
    };
    visit(tree);
  };
}

export const AiMarkdown = memo(function AiMarkdown({ text, files, onPage }: { text: string; files?: string[]; onPage: (page: number, file?: string) => void }) {
  return (
    <ReactMarkdown
      skipHtml
      disallowedElements={["img"]}
      remarkPlugins={[[remarkMath, { singleDollarTextMath: false }], [remarkPageReferences, files], remarkBreaks]}
      rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 }]]}
      components={{
        a: ({ node, children }) => {
          const page = Number(node?.properties["data-folio-page"]);
          if (!(Number.isSafeInteger(page) && page > 0)) return <>{children}</>;
          const file = node?.properties["data-folio-file"];
          return typeof file === "string"
            ? <button className="page-ref" onClick={() => onPage(page, file)} title={`Go to page ${page} of ${file}`}>{children}</button>
            : <button className="page-ref" onClick={() => onPage(page)} title={`Go to page ${page}`}>{children}</button>;
        },
      }}
    >
      {normalizeMathDelimiters(text)}
    </ReactMarkdown>
  );
});
