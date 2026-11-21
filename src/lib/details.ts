import { findParentNode, InputRule } from "@tiptap/core";
import { Details as BaseDetails } from "@tiptap/extension-details";
import type { Node } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

export { DetailsContent, DetailsSummary } from "@tiptap/extension-details";

/** Notion-style toggles, saved as HTML `<details>` so other markdown apps (and GitHub) show them too. */
export const Details = BaseDetails.extend({
  // Before the quote's "> " rule, so "> " makes a toggle as in Notion.
  priority: 101,

  addOptions() {
    return { ...this.parent!(), persist: true };
  },

  // Greys out the arrow while there is nothing inside, as in Notion.
  addNodeView() {
    const createView = this.parent!()!;
    return (props) => {
      const view = createView(props);
      const button = (view.dom as HTMLElement).querySelector(":scope > button");
      const mark = (node: Node) => {
        const content = node.lastChild;
        button?.classList.toggle("empty", content?.childCount === 1 && !content.firstChild?.content.size);
      };
      mark(props.node);
      return {
        ...view,
        update: (node, decorations, innerDecorations) => {
          const updated = view.update?.(node, decorations, innerDecorations) ?? false;
          if (updated) mark(node);
          return updated;
        },
      };
    };
  },

  addCommands() {
    return {
      ...this.parent?.(),
      // The block becomes the toggle's title, as in Notion, rather than its hidden content.
      setDetails:
        () =>
        ({ tr, dispatch }) => {
          const { $from } = tr.selection;
          const block = $from.parent;
          const index = $from.index(-1);
          if (!block.isTextblock || block.type.spec.code || block.type.name === "detailsSummary") return false;
          if (!$from.node(-1).canReplaceWith(index, index + 1, this.type)) return false;
          const text: Node[] = [];
          block.content.forEach((node) => node.isText && text.push(node));
          const toggle = this.type.createAndFill(null, tr.doc.type.schema.nodes.detailsSummary.create(null, text));
          if (!toggle) return false;
          if (dispatch) {
            const start = $from.before();
            tr.replaceWith(start, $from.after(), toggle);
            tr.setSelection(TextSelection.create(tr.doc, start + 2 + Math.min($from.parentOffset, toggle.firstChild!.content.size)));
          }
          return true;
        },
    };
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^>\s$/,
        handler: ({ range, chain }) => {
          chain().deleteRange(range).setDetails().run();
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const shortcuts = this.parent?.() ?? {};
    return {
      ...shortcuts,
      // Enter in a closed toggle's title makes another toggle below, and in an empty title turns it back into text, like lists.
      Enter: (props) => {
        const { state, view } = props.editor;
        const { selection, schema } = state;
        const { $head } = selection;
        if (!selection.empty || $head.parent.type.name !== "detailsSummary") return shortcuts.Enter?.(props) ?? false;
        const [start, end] = [$head.before(-1), $head.after(-1)];
        const details = $head.node(-1);
        const content = details.child(1);
        if (!$head.parent.content.size) {
          if (content.childCount > 1 || content.textContent) return props.editor.commands.unsetDetails();
          const tr = state.tr.replaceWith(start, end, schema.nodes.paragraph.create());
          view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + 1)));
          return true;
        }
        if (details.attrs.open) {
          // An open toggle that is still empty has a line waiting inside; go there instead of adding another.
          if (content.childCount > 1 || content.firstChild!.content.size) return shortcuts.Enter?.(props) ?? false;
          view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, end - 3)));
          return true;
        }
        const toggle = this.type.createAndFill(null, [
          schema.nodes.detailsSummary.create(null, $head.parent.content.cut($head.parentOffset)),
        ]);
        if (!toggle) return false;
        const tr = state.tr.insert(end, toggle).delete($head.pos, $head.end());
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(end, -1) + 2)).scrollIntoView());
        return true;
      },
      // Opens or closes the toggle holding the cursor, which moves to its title when the content hides.
      "Mod-Enter": ({ editor }) => {
        const details = findParentNode((node) => node.type === this.type)(editor.state.selection);
        if (!details) return false;
        const open = !details.node.attrs.open;
        const tr = editor.state.tr.setNodeAttribute(details.pos, "open", open);
        const summaryEnd = details.pos + 2 + details.node.firstChild!.content.size;
        if (!open && editor.state.selection.from > summaryEnd) tr.setSelection(TextSelection.create(tr.doc, summaryEnd));
        editor.view.dispatch(tr);
        return true;
      },
    };
  },

  markdownTokenizer: {
    name: "details",
    level: "block",
    start: (src) => src.search(/^<details( open)?>/m),
    tokenize(src, _tokens, lexer) {
      const open = src.match(/^<details( open)?>[ \t]*(?:\r?\n)?[ \t]*<summary>(.*?)<\/summary>[ \t]*\r?\n/);
      if (!open) return undefined;
      // Finds the matching close, past any toggles nested inside.
      const tags = /<\/?details( open)?>/g;
      tags.lastIndex = open[0].length;
      let depth = 1;
      for (let tag; (tag = tags.exec(src)); ) {
        depth += tag[0].startsWith("</") ? -1 : 1;
        if (depth) continue;
        const end = tags.lastIndex;
        return {
          type: "details",
          raw: src.slice(0, end),
          open: !!open[1],
          summary: lexer.inlineTokens(open[2]),
          tokens: lexer.blockTokens(src.slice(open[0].length, tag.index)),
        };
      }
      return undefined;
    },
  },

  parseMarkdown: (token, h) => {
    const content = h.parseChildren(token.tokens ?? []);
    return h.createNode("details", { open: token.open }, [
      h.createNode("detailsSummary", {}, h.parseInline(token.summary ?? [])),
      h.createNode("detailsContent", {}, content.length ? content : [h.createNode("paragraph")]),
    ]);
  },

  renderMarkdown: (node, h) => {
    const [summary, content] = node.content ?? [];
    const tag = node.attrs?.open ? "<details open>" : "<details>";
    return `${tag}\n<summary>${h.renderChildren(summary?.content ?? [])}</summary>\n\n${h.renderChildren(content?.content ?? [], "\n\n")}\n\n</details>`;
  },
});
