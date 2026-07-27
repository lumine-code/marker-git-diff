const { CompositeDisposable, Disposable } = require("atom");

const MAX_BUFFER_LENGTH_TO_DIFF = 2 * 1024 * 1024;

// The line diffs of one editor, shared by every layer drawing it.
//
// Each renderer builds its own layer from the descriptor, so resolving the
// repository and shipping the whole buffer to the git worker from `initialize`
// would do both twice for the same editor on every pause in typing. The source
// is refcounted instead: the first layer creates it, the last one to detach
// takes it down.
class DiffSource {
  constructor(editor) {
    this.editor = editor;
    this.layers = new Set();
    // Null until the first cycle produced hunks, so a layer attaching to a
    // source that has nothing yet is not seeded with an answer.
    this.diffs = null;
    this.repository = null;
    this.editorPath = null;
    this.repoSubscriptions = null;
    this.repositoryGeneration = 0;
    this.diffGeneration = 0;
    this.destroyed = false;
    this.refresh = this.refresh.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.disposables = new CompositeDisposable(
      atom.repositories.onDidChange(this.subscribe),
      editor.onDidStopChanging(this.refresh),
      editor.onDidChangePath(this.subscribe),
    );
    this.subscribe();
  }

  addLayer(layer) {
    this.layers.add(layer);
    if (this.diffs) {
      layer.cache.set("diffs", this.diffs);
      layer.update();
    }
  }

  // Answers whether that was the last layer drawing this editor.
  delLayer(layer) {
    this.layers.delete(layer);
    return this.layers.size === 0;
  }

  // Hand the current hunks to every layer of this editor.
  //
  // A destroyed layer is out of the set before anything can reach it here: the
  // host cancels its throttle and clears its cache, so a diff resolving after
  // teardown must not call `update()` on it.
  publish(diffs) {
    this.diffs = diffs;
    for (const layer of this.layers) {
      layer.cache.set("diffs", diffs);
      layer.update();
    }
  }

  // Resolve the repository owning the editor's path and (re)subscribe to its
  // status events, mirroring the bundled git-diff package.
  async subscribe() {
    const generation = ++this.repositoryGeneration;
    if (this.repoSubscriptions) {
      this.repoSubscriptions.dispose();
      this.disposables.remove(this.repoSubscriptions);
      this.repoSubscriptions = null;
    }
    const editorPath = this.editor.getPath();
    const repository = editorPath ? await atom.repositories.resolveForPath(editorPath) : null;
    if (
      this.destroyed ||
      generation !== this.repositoryGeneration ||
      editorPath !== this.editor.getPath()
    ) {
      return;
    }
    this.repository = repository;
    this.editorPath = editorPath;
    if (!repository) {
      this.publish([]);
      return;
    }
    this.repoSubscriptions = new CompositeDisposable(
      repository.onDidDestroy(this.subscribe),
      repository.onDidChangeStatuses(this.refresh),
      repository.onDidChangeStatusSnapshot(this.refresh),
      repository.onDidChangeStatus(({ path: changedPath }) => {
        if (changedPath === this.editorPath) {
          this.refresh();
        }
      }),
    );
    this.disposables.add(this.repoSubscriptions);
    await this.refresh();
  }

  // Recompute the line diffs off-thread via the git-host worker.
  async refresh() {
    const buffer = this.editor.getBuffer();
    if (!this.repository || this.repository.isDestroyed() || !this.editorPath) {
      return;
    }
    if (buffer.getLength() >= MAX_BUFFER_LENGTH_TO_DIFF) {
      return;
    }
    const generation = ++this.diffGeneration;
    // Line diffs against HEAD are meaningless for untracked files and
    // misleading while a merge conflict is unresolved.
    const statusEntry = this.repository.getStatusEntry(this.editorPath);
    let diffs;
    if (statusEntry?.untracked || statusEntry?.conflicted) {
      diffs = [];
    } else {
      try {
        diffs = (await this.repository.getLineDiffsAsync(this.editorPath, buffer.getText())) || [];
      } catch {
        return;
      }
    }
    // A newer refresh superseded this one while the worker was busy, or the
    // last layer detached and took the source down with it.
    if (this.destroyed || generation !== this.diffGeneration || buffer.isDestroyed()) {
      return;
    }
    this.publish(diffs);
  }

  destroy() {
    this.destroyed = true;
    this.disposables.dispose();
    this.layers.clear();
  }
}

module.exports = {
  activate() {
    this.sources = new Map();
  },

  deactivate() {
    for (const source of this.sources.values()) {
      source.destroy();
    }
    this.sources.clear();
  },

  sourceForEditor(editor) {
    return this.sources.get(editor);
  },

  provideMarkerLayer() {
    return {
      name: "git-diff",
      description: "Git diff markers",
      position: "right",
      timer: 100,
      merge: true,
      threshold: "marker-git-diff.threshold",
      initialize: (layer) => {
        let source = this.sources.get(layer.editor);
        if (!source) {
          source = new DiffSource(layer.editor);
          this.sources.set(layer.editor, source);
        }
        source.addLayer(layer);
        layer.disposables.add(
          new Disposable(() => {
            if (source.delLayer(layer)) {
              source.destroy();
              this.sources.delete(layer.editor);
            }
          }),
        );
      },
      getItems: ({ editor, cache }) => {
        const items = [];
        for (const { newStart, oldLines, newLines } of cache.get("diffs") ?? []) {
          let cls, startRow, endRow;
          if (oldLines === 0 && newLines > 0) {
            cls = "added";
            startRow = newStart - 1;
            endRow = newStart + newLines - 2;
          } else if (newLines === 0 && oldLines > 0) {
            cls = "removed";
            startRow = Math.max(newStart - 1, 0);
            endRow = startRow;
          } else {
            cls = "modified";
            startRow = newStart - 1;
            endRow = Math.max(newStart + newLines - 2, startRow);
          }
          items.push({
            row: editor.screenRowForBufferRow(startRow),
            end: editor.screenRowForBufferRow(endRow),
            cls,
          });
        }
        return items;
      },
    };
  },
};
