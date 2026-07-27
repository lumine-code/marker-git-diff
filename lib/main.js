const { CompositeDisposable, Disposable } = require("atom");

const MAX_BUFFER_LENGTH_TO_DIFF = 2 * 1024 * 1024;

// The line diffs of one editor, feeding its single layer.
//
// The source owns repository resolution, subscriptions, and the async traffic
// to the git worker; the layer only carries the cache the renderer reads. One
// layer per (provider, editor) is guaranteed by the hub, so the source lives
// and dies with its layer.
class DiffSource {
  constructor(layer) {
    this.layer = layer;
    this.editor = layer.editor;
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
      this.editor.onDidStopChanging(this.refresh),
      this.editor.onDidChangePath(this.subscribe),
    );
    this.subscribe();
  }

  // Hand the current hunks to the layer.
  //
  // A destroyed layer can never be reached here: it takes the source down with
  // it, and every async path checks `destroyed` before publishing, so a diff
  // resolving after teardown must not call `update()` on it.
  publish(diffs) {
    this.layer.cache.set("diffs", diffs);
    this.layer.update();
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
    // layer detached and took the source down with it.
    if (this.destroyed || generation !== this.diffGeneration || buffer.isDestroyed()) {
      return;
    }
    this.publish(diffs);
  }

  destroy() {
    this.destroyed = true;
    this.disposables.dispose();
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
        const source = new DiffSource(layer);
        this.sources.set(layer.editor, source);
        layer.disposables.add(
          new Disposable(() => {
            source.destroy();
            this.sources.delete(layer.editor);
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
