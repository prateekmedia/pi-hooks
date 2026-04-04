/**
 * Shared UI utilities for pi-hooks extensions.
 */
import { Text, matchesKey } from "@mariozechner/pi-tui";

/**
 * Like ctx.ui.select() but options are numbered and pressing a digit key
 * instantly selects the corresponding item. Also supports arrow keys + enter.
 * Escape cancels (returns null).
 */
export async function numberedSelect(
  ctx: any,
  title: string,
  options: string[],
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui: any, theme: any, _kb: any, done: (v: string | null) => void) => {
    let selected = 0;

    function buildText() {
      const lines: string[] = [];
      lines.push(theme.bold(theme.fg("warning", title)));
      lines.push("");
      for (let i = 0; i < options.length; i++) {
        const marker = i === selected ? theme.fg("accent", "▸") : " ";
        const label = i === selected ? theme.fg("accent", options[i]) : options[i];
        lines.push(`  ${marker} ${theme.bold(String(i + 1))}  ${label}`);
      }
      return lines.join("\n");
    }

    const text = new Text(buildText(), 0, 0);

    return {
      render: (w: number) => text.render(w),
      invalidate: () => text.invalidate(),
      handleInput: (data: string) => {
        // Number keys 1-9
        const num = parseInt(data, 10);
        if (num >= 1 && num <= options.length) {
          done(options[num - 1]);
          return;
        }
        // Arrow down / j
        if (matchesKey(data, "down") || data === "j") {
          selected = (selected + 1) % options.length;
          text.setText(buildText());
          tui.requestRender();
          return;
        }
        // Arrow up / k
        if (matchesKey(data, "up") || data === "k") {
          selected = (selected - 1 + options.length) % options.length;
          text.setText(buildText());
          tui.requestRender();
          return;
        }
        // Enter
        if (matchesKey(data, "return")) {
          done(options[selected]);
          return;
        }
        // Escape
        if (matchesKey(data, "escape")) {
          done(null);
          return;
        }
      },
    };
  });
}
