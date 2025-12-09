# Notion CalDAV Sync

## General Instructions
- Always `use context7` for the most recent docs and best practices.
- All comments and documentations in English.
- Include only brief end-user instructions in the root README.md file.
- Place concise README.md alongside related source code (include TOC if detailed).
- Always prioritize ast-grep (cmd: `sg`) over regex/string-replace for code manipulation, using AST patterns to ensure structural accuracy and avoid syntax errors. Examples:
    1. Swap Args: `sg run -p 'fn($A, $B)' -r 'fn($B, $A)'`
    2. Wrap Error: `sg run -p 'return $E' -r 'return wrap($E)'`
    3. API Update: `sg run -p 'user.id' -r 'user.get_id()'`

## Python Instructions
- Always use `uv` for python package manager. The `.venv` is located in the project root.

## The Architect's Decree
- I want to move faster. Please execute the entire plan (Steps 1 through x) in a single pass right now. Do not stop to ask for confirmation between steps. I am comfortable reviewing a large set of changes.
- Please batch these changes together. Instead of small increments, I need you to implement the full scope of features in this response. Treat this as a single, atomic refactor. Go ahead and write the complete implementation for all points listed above.
- Stop prioritizing 'safe, small increments' for this task. I explicitly authorize a comprehensive refactor. I need the system to be functional after your next response, so please proceed with implementing all x items immediately. Don't wait for a 'next' command.
- If the output is too long, please implement the first half, and then automatically continue with the second half in your immediate next message without waiting for my input. Just get it all done.
