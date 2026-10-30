import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { normalizeMathDelimiters } from "./chatMath";
import "katex/dist/katex.min.css";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
}

// Transform only prose text, so page references never alter code, maths or links.
function remarkPageReferences() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || ["link", "linkReference", "code", "inlineCode", "math", "inlineMath"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const parts: MarkdownNode[] = [];
        const pattern = /\((?:p|pp|page|pages)\.?\s*(\d+)(?:[–-]\d+)?\)/gi;
        let last = 0;
        for (const match of child.value.matchAll(pattern)) {
          if (match.index! > last) parts.push({ type: "text", value: child.value.slice(last, match.index) });
          parts.push({ type: "link", url: `#folio-page-${match[1]}`, children: [{ type: "text", value: match[0] }] });
          last = match.index! + match[0].length;
        }
        if (last < child.value.length) parts.push({ type: "text", value: child.value.slice(last) });
        return parts;
      });
    };
    visit(tree);
  };
}

export const AiMarkdown = memo(function AiMarkdown({ text, onPage }: { text: string; onPage: (n: number) => void }) {
  return (
    <ReactMarkdown
      skipHtml
      disallowedElements={["img"]}
      remarkPlugins={[[remarkMath, { singleDollarTextMath: false }], remarkPageReferences]}
      rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 }]]}
      components={{
        a: ({ href, children }) => {
          const page = /^#folio-page-(\d+)$/.exec(href ?? "");
          return page
            ? <button className="page-ref" onClick={() => onPage(Number(page[1]))} title={`Go to page ${page[1]}`}>{children}</button>
            : <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
      }}
    >
      {normalizeMathDelimiters(text)}
    </ReactMarkdown>
  );
});
