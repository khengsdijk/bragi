# fixtures/projects

Song documents used by the tests of all three languages (WP-0.2) and, later, by the engine and
model work packages.

| File | What it is |
|---|---|
| `example-02-10.json` | The example document in [specs/02-song-model.md §10](../../specs/02-song-model.md). The TypeScript contract test extracts that Markdown block and asserts the two are equal, so **edit the spec and this file together**. |
| `invalid-cases.json` | Invalid documents, each a mutation of an example. Every language's test asserts that `checkedBy` lists it. The file's `comment` explains the one asymmetry: typify does not check **float** bounds, so `bragi-model::validate` owns those (WP-0.3). |

One valid instance per root schema type lives next door in
[`packages/schemas/examples/`](../../packages/schemas/examples); the tests assert that the set of files
there equals the root types the code generator found.

## Licence

Both files are **original work by the project** and contain no audio, lyrics or third-party data:
they are JSON documents with invented titles, labels and hashes. They are covered by the repository's
licence (see [`LICENSE.txt`](LICENSE.txt)) and are not derived from any copyrighted recording. See
the content policy in [specs/10-fusion.md §7](../../specs/10-fusion.md).
