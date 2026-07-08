/* ============================================================================
 * Lists & notes. "add milk to my grocery list", "what's on my to-do list",
 * "check off eggs", "start a packing list". The lists live on the DEVICE
 * (localStorage + iCloud sync like the user profile) — the server only detects
 * the intent + extracts {op, list, item}; the device mutates its store and
 * confirms. Deliberately requires a list cue ("list" or a known list noun) so
 * "remind me to…" / "remember…" are never captured here.
 * ==========================================================================*/

export type ListOp = "add" | "remove" | "show" | "create" | "clear" | "showAll";
export interface ListCommand {
  op: ListOp;
  list: string;   // canonical list name ("grocery", "to-do", …); "" for showAll
  item?: string;  // for add/remove
}

const LIST_NOUN = /\b(list|lists|groceries|grocery|shopping|to-?dos?|todos?|packing|bucket|wish\s?list|reading|watch\s?list)\b/;

// Normalize a list name: drop a trailing "list", collapse synonyms, trim.
function normList(raw: string): string {
  let n = (raw || "")
    .toLowerCase()
    .replace(/[?.!,]+$/g, "")
    .replace(/^\s*(my|the|a|an)\s+/,"")
    .replace(/\s*\blist$/,"")   // "grocery list" → "grocery", bare "list" → ""
    .replace(/\s+/g, " ")
    .trim();
  if (/^(groceries|grocery)$/.test(n)) n = "grocery";
  else if (/^(to-?dos?|todos?|things? to do|task)$/.test(n)) n = "to-do";
  else if (/^shopping$/.test(n)) n = "shopping";
  if (!n || n === "list") n = "to-do"; // "add X to my list" with no name → default
  return n.slice(0, 40);
}

function cleanItem(raw: string): string {
  return (raw || "")
    .replace(/[?.!,]+$/g, "")
    .replace(/^\s*(some|a|an|the)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function hasListCue(rest: string): boolean {
  return /\blist\b/.test(rest) || LIST_NOUN.test(rest);
}

export function parseListCommand(message: string): ListCommand | null {
  const m = message.toLowerCase().trim();
  // Never hijack a reminder / long-term memory command.
  if (/^\s*(remind me|remember|note to self|don'?t forget to)\b/.test(m)) return null;

  // "show my lists" / "what lists do I have"
  if (/\b(show|see|view|what(?:'?s| are| is)|list)\b[^.]*\bmy\s+lists\b/.test(m) || /^(?:my\s+)?lists\??$/.test(m) || /\bwhat lists\b/.test(m)) {
    return { op: "showAll", list: "" };
  }

  // add: "add X to my grocery list" / "put X on my shopping list" / "add X to my groceries"
  let mm = m.match(/\b(?:add|put|throw|toss|jot(?:\s+down)?|stick)\s+(.+?)\s+(?:to|on|onto|in|into)\s+(?:my\s+|the\s+)?(.+)$/);
  if (mm && hasListCue(mm[2])) return { op: "add", list: normList(mm[2]), item: cleanItem(mm[1]) };

  // remove: "remove X from my grocery list" / "take X off my list"
  mm = m.match(/\b(?:remove|delete|take|scratch|drop)\s+(?:off\s+)?(.+?)\s+(?:off|from)\s+(?:my\s+|the\s+)?(.+)$/);
  if (mm && hasListCue(mm[2])) return { op: "remove", list: normList(mm[2]), item: cleanItem(mm[1]) };
  // "check off X (on|from my ... list)" / "cross off X"
  mm = m.match(/\b(?:check|cross)\s+off\s+(.+?)(?:\s+(?:on|from|in)\s+(?:my\s+|the\s+)?(.+))?$/);
  if (mm && (mm[2] ? hasListCue(mm[2]) : /\blist\b/.test(m))) {
    return { op: "remove", list: normList(mm[2] || "to-do"), item: cleanItem(mm[1]) };
  }

  // create: "start a packing list" / "create a list called X" / "make a grocery list"
  mm = m.match(/\b(?:create|start|make|new|begin)\s+(?:a\s+|an\s+|my\s+)?list\s+(?:called|named|for)\s+(.+)$/);
  if (mm) return { op: "create", list: normList(mm[1]) };
  mm = m.match(/\b(?:create|start|make|new|begin)\s+(?:a\s+|an\s+|my\s+)?(.+?\s*list)\b/);
  if (mm) return { op: "create", list: normList(mm[1]) };

  // clear/delete a whole list: "clear my grocery list" / "delete my packing list"
  mm = m.match(/\b(?:clear|empty|delete|erase|wipe|remove)\s+(?:my\s+|the\s+|out\s+)?(.+?\s*list)\b/);
  if (mm) return { op: "clear", list: normList(mm[1]) };

  // show a specific list: "what's on my grocery list" / "read my to-do list"
  mm = m.match(/\b(?:what(?:'?s| is)\s+on|show|read|see|view|pull up|check|go through)\b[^.]*?(?:my\s+|the\s+)?([a-z' -]+?\s*list)\b/);
  if (mm) return { op: "show", list: normList(mm[1]) };
  // "what's on my groceries" (list noun, no "list" word)
  mm = m.match(/\b(?:what(?:'?s| is)\s+on|show|read)\b[^.]*?(?:my\s+|the\s+)?(groceries|grocery|shopping|to-?do list|packing)\b/);
  if (mm) return { op: "show", list: normList(mm[1]) };

  return null;
}
