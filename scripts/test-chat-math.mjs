// Offline regression checks for chat formatting; no PDF, account, or network access is needed.
import assert from "node:assert/strict";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom" });
let passed = 0;

try {
  const { AiMarkdown } = await server.ssrLoadModule("/src/AiMarkdown.tsx");
  const { normalizeMathDelimiters } = await server.ssrLoadModule("/src/chatMath.ts");
  const render = (text) => renderToStaticMarkup(React.createElement(AiMarkdown, { text, onPage: () => {} }));
  const mathCount = (html) => [...html.matchAll(/class="katex"/g)].length;
  const pageRefCount = (html) => [...html.matchAll(/<button\b[^>]*class="[^"]*\bpage-ref\b/g)].length;
  const check = (name, test) => {
    test();
    passed++;
    console.log(`ok  ${name}`);
  };

  check("display equations render with accessible math", () => {
    const html = render(String.raw`Investor preferences:
\[
V(\widetilde W_{1i},X_i)=-\exp\!\left(-A_i\widetilde W_{1i}-d_i g'X_i\right).
\]

Equilibrium expected returns:
\[
\boxed{\mu=\mu_m\beta_m-\frac{\bar d}{a}g}
\]`);
    assert.equal(mathCount(html), 2);
    assert.equal([...html.matchAll(/class="katex-display"/g)].length, 2);
    assert.match(html, /<math\b/);
    assert.doesNotMatch(html, /class="katex-error"/);
  });

  check("inline parentheses, inline dollars and display dollars all render", () => {
    const html = render(String.raw`Here \(X_i\) is the portfolio and $A_i$ is risk aversion.

$$
\mu=\alpha+\beta x
$$`);
    assert.equal(mathCount(html), 3);
    assert.equal([...html.matchAll(/class="katex-display"/g)].length, 1);
    assert.match(html, /Here /);
    assert.match(html, / is the portfolio and /);
  });

  check("currency amounts remain ordinary prose", () => {
    for (const text of ["It costs $5 and $10.", "Amounts are $5, $10, and $20.", "An escaped \\$5 remains money."]) {
      assert.equal(mathCount(render(text)), 0, text);
    }
  });

  check("math-like dollar syntax in URLs and link destinations stays unchanged", () => {
    for (const text of [
      "Source https://example.test/$x$/paper.pdf",
      "[Source](https://example.test/$x$/paper.pdf)",
      "[Source](../$x$/paper.pdf)",
      "[Source](../chapter(1)/$x$.pdf)",
    ]) {
      assert.equal(normalizeMathDelimiters(text), text);
      assert.equal(mathCount(render(text)), 0, text);
    }
    assert.equal(mathCount(render("https://example.test/$x$ followed by $y_i$.")), 1);
  });

  check("display equations retain their list item", () => {
    for (const text of [
      String.raw`- **Pricing**:
  \[
  \mu=\alpha+\beta x
  \]
  See (p. 4).`,
      String.raw`1. \[\mu=\alpha+\beta x\] See (p. 4).`,
    ]) {
      const html = render(text);
      assert.equal(mathCount(html), 1);
      assert.match(html, /<li>[\s\S]*class="katex-display"[\s\S]*<\/li>/);
      assert.equal(pageRefCount(html), 1);
      assert.doesNotMatch(html, /<pre>/);
    }
  });

  check("indented list continuations render while indented code stays literal", () => {
    for (const math of [String.raw`\(x_i\)`, String.raw`\[x_i\]`, "$x_i$"]) {
      const html = render(`- First\n    ${math}`);
      assert.equal(mathCount(html), 1);
      assert.match(html, /<li>[\s\S]*class="katex"[\s\S]*<\/li>/);
      assert.doesNotMatch(html, /<pre>/);
    }
    for (const text of [
      String.raw`    Code \(literal\)` + "\n\n" + String.raw`After: \(y\).`,
      String.raw`- First` + "\n\n" + String.raw`      Code \(literal\)` + "\n\n" + String.raw`After: \(y\).`,
    ]) {
      const html = render(text);
      assert.equal(mathCount(html), 1);
      assert.match(html, /<pre><code>Code \\\(literal\\\)/);
    }
  });

  check("display equations stay inside quotes without changing their contents", () => {
    for (const text of [
      String.raw`> \[
> x_i
> \]`,
      String.raw`> - Example
>   \[
>     x_i
>   \]`,
      String.raw`- > Example
  > \[
  > x_i
  > \]`,
    ]) {
      const html = render(text);
      assert.equal(mathCount(html), 1);
      assert.ok(html.indexOf('class="katex-display"') < html.indexOf("</blockquote>"));
      assert.match(html, /<annotation encoding="application\/x-tex">x_i<\/annotation>/);
    }
  });

  check("inline equations may wrap across source lines", () => {
    const html = render(String.raw`One: \(x_i
 + y_i\).`);
    assert.equal(mathCount(html), 1);
    assert.match(html, /<annotation encoding="application\/x-tex">x_i \+ y_i<\/annotation>/);
    assert.doesNotMatch(html, /<(?:ul|code)\b/);
  });

  check("literal backticks do not hide subsequent equations", () => {
    for (const text of [
      "```literal```\n\n" + String.raw`Equation: \(x_i\).`,
      "An unmatched backtick ` is literal. " + String.raw`Equation: \(x_i\).`,
    ]) {
      const html = render(text);
      assert.equal(mathCount(html), 1);
      assert.doesNotMatch(html, /<pre>/);
    }
  });

  check("inline code retains literal delimiters", () => {
    const text = String.raw`Use \(x_i\), then type ` + "`" + String.raw`\(y_i\) $z_i$` + "` literally.";
    const html = render(text);
    assert.equal(mathCount(html), 1);
    assert.match(html, /<code>\\\(y_i\\\) \$z_i\$<\/code>/);
  });

  check("fenced TeX and unlabelled code remain literal", () => {
    for (const marker of ["```", "~~~"]) {
      for (const language of ["", "tex"]) {
        const text = `${marker}${language}\n` + String.raw`\[x_i\] and $y_i$` + `\n${marker}`;
        assert.equal(normalizeMathDelimiters(text), text);
        const html = render(text);
        assert.equal(mathCount(html), 0);
        assert.match(html, /<pre><code\b/);
        assert.match(html, /\\\[x_i\\\] and \$y_i\$/);
      }
    }
  });

  check("citations remain buttons and are excluded from math and code", () => {
    const html = render(String.raw`A result (p.4), another result (pp.2–3).

\(\text{(p. 7)}\) and ` + "`(p. 8)`");
    assert.equal(pageRefCount(html), 2);
    assert.match(html, /Go to page 4/);
    assert.match(html, /Go to page 2/);
    assert.equal(mathCount(html), 1);
    assert.match(html, /<code>\(p\. 8\)<\/code>/);
  });

  check("raw HTML and Markdown images cannot create active content", () => {
    const html = render('<script>alert(1)</script>\n\n<img src="https://example.test/leak" onerror="alert(1)">\n\n![tracking](https://example.test/tracker.png)');
    assert.doesNotMatch(html, /<(?:script|img|iframe|object|embed)\b/i);
    assert.doesNotMatch(html, /\bonerror=/i);
  });

  check("untrusted KaTeX commands cannot add links, images or HTML classes", () => {
    const html = render(String.raw`\(\href{javascript:alert(1)}{click}\)

\(\includegraphics{https://example.test/image.png}\)

\(\htmlClass{injected-class}{x}\)`);
    assert.doesNotMatch(html, /<a\b[^>]*href="javascript:/i);
    assert.doesNotMatch(html, /<img\b/i);
    assert.doesNotMatch(html, /class="[^"]*injected-class/);
  });

  check("invalid and incomplete math stay readable without throwing", () => {
    for (const text of [String.raw`\[\frac{1}{`, String.raw`\(\unknowncommand{x}\)`, "$x_i", "$$\n\\frac{"]) {
      const html = render(text);
      assert.ok(html.length > 0, text);
    }
    const pending = render(String.raw`\[
\boxed{\mu
=
\mu_m\beta_m
-
\frac{\bar d}{a}`);
    assert.match(pending, /<pre><code/);
    assert.doesNotMatch(pending, /<h[1-6]\b/);
    assert.match(pending, /\\boxed/);
  });

  check("each streamed prefix of a mixed prose/equation answer renders safely", () => {
    const text = String.raw`The portfolio \(X_i\) has expected return:
\[
\boxed{\mu=\mu_m\beta_m-\frac{\bar d}{a}g}
\]
See (p. 4). The example costs $5 and $10. Code: ` + "`$literal$`";
    for (let end = 0; end <= text.length; end++) {
      assert.doesNotThrow(() => render(text.slice(0, end)), `stream prefix ${end}`);
    }
  });

  console.log(`PASS (${passed} chat-math regression checks)`);
} finally {
  await server.close();
}
