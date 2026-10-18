#!/usr/bin/env node
/**
 * Placeholder for a command from specs/13-agent-guide.md §9 whose owning work
 * package has not landed yet. It fails loudly and says who will implement it,
 * so the command surface is discoverable without pretending to work.
 */
const [command, wp, description] = process.argv.slice(2);

console.error(`\n  ${command ?? "this command"} is not implemented yet.`);
if (description) console.error(`  Planned behaviour: ${description}.`);
if (wp) console.error(`  Owned by WP-${wp} — see specs/12-roadmap.md.`);
console.error("");
process.exit(1);
