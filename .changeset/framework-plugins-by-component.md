---
"@aburi/types": minor
"@aburi/core": minor
---

A framework plugin is asked about a file only when the file's Component allows it: a Component
whose `frameworks` list any skips a plugin that provides only frameworks component detection
records and none the list holds (or names the plugin itself). A monorepo's API package is no
longer classified by `framework-react` because its front end depends on React. A file in no
Component, a Component recording no framework, a `frameworkHints` entry and a plugin providing no
framework are unaffected.

`FrameworkClassifyContext` gains `component` (`FileComponent`: the Component's id, the root of it
the file lies under, and its `frameworks`), or `null` for a file no Component holds.
