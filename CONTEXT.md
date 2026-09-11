# Indexary

Indexary presents and helps discover knowledge stored as ordinary files without owning or rewriting that knowledge.

## Content

**Knowledge Base**:
A single directory tree whose documents, metadata, links, folders, and attachments are the source of truth for one running Indexary instance.
_Avoid_: Vault, repository, storage

**Document**:
A Markdown file in the Knowledge Base and the primary unit a person browses and searches.
_Avoid_: Note, page

**Home Document**:
The Document at `/index.md` in the root of the Knowledge Base, displayed at the application root.
_Avoid_: Home page, start page

**Source Material**:
A non-Markdown file that a Document identifies as the material from which it was derived or to which it primarily refers.
_Avoid_: Original, source attachment

**Attachment**:
A non-Markdown file referenced by a Document that is not its Source Material.
