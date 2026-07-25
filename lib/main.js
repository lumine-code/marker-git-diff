const { CompositeDisposable } = require("atom");

const MAX_BUFFER_LENGTH_TO_DIFF = 2 * 1024 * 1024;

module.exports = {
  activate() {
    this.disposables = new CompositeDisposable(
      atom.config.observe("scrollmap-git-diff.threshold", (value) => {
        this.threshold = value;
      }),
    );
  },

  deactivate() {
    this.disposables.dispose();
  },

  provideScrollmap() {
    return {
      name: "git",
      description: "Git diff markers",
      position: "right",
      timer: 100,
      initialize: (layer) => {
        const { editor, cache, disposables, update } = layer;
        cache.set("diffs", []);
        let repoSubscriptions = null;
        let repositoryGeneration = 0;
        let diffGeneration = 0;

        // Recompute the line diffs off-thread via the git-host worker and
        // push the fresh hunks into the layer cache.
        const refreshDiffs = async () => {
          const repository = cache.get("repository");
          const editorPath = cache.get("path");
          const buffer = editor.getBuffer();
          if (!repository || repository.isDestroyed() || !editorPath) {
            return;
          }
          if (buffer.getLength() >= MAX_BUFFER_LENGTH_TO_DIFF) {
            return;
          }
          const generation = ++diffGeneration;
          // Line diffs against HEAD are meaningless for untracked files and
          // misleading while a merge conflict is unresolved.
          const statusEntry = repository.getStatusEntry(editorPath);
          let diffs;
          if (statusEntry?.untracked || statusEntry?.conflicted) {
            diffs = [];
          } else {
            try {
              diffs = (await repository.getLineDiffsAsync(editorPath, buffer.getText())) || [];
            } catch {
              return;
            }
          }
          // A newer refresh superseded this one while the worker was busy.
          if (generation !== diffGeneration || buffer.isDestroyed()) {
            return;
          }
          cache.set("diffs", diffs);
          update();
        };

        // Resolve the repository owning the editor's path and (re)subscribe
        // to its status events, mirroring the bundled git-diff package.
        const subscribeToRepository = async () => {
          const generation = ++repositoryGeneration;
          if (repoSubscriptions) {
            repoSubscriptions.dispose();
            disposables.remove(repoSubscriptions);
            repoSubscriptions = null;
          }
          const editorPath = editor.getPath();
          const repository = editorPath ? await atom.repositories.resolveForPath(editorPath) : null;
          if (generation !== repositoryGeneration || editorPath !== editor.getPath()) {
            return;
          }
          cache.set("repository", repository);
          cache.set("path", editorPath);
          if (!repository) {
            cache.set("diffs", []);
            update();
            return;
          }
          repoSubscriptions = new CompositeDisposable(
            repository.onDidDestroy(subscribeToRepository),
            repository.onDidChangeStatuses(refreshDiffs),
            repository.onDidChangeStatusSnapshot(refreshDiffs),
            repository.onDidChangeStatus(({ path: changedPath }) => {
              if (changedPath === cache.get("path")) {
                refreshDiffs();
              }
            }),
          );
          disposables.add(repoSubscriptions);
          refreshDiffs();
        };

        cache.set("refreshDiffs", refreshDiffs);
        disposables.add(
          atom.repositories.onDidChange(subscribeToRepository),
          editor.onDidStopChanging(refreshDiffs),
          editor.onDidChangePath(subscribeToRepository),
          atom.config.onDidChange("scrollmap-git-diff.threshold", update),
        );
        subscribeToRepository();
      },
      getItems: ({ editor, cache }) => {
        const ranges = [];
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
          ranges.push({
            startRow: editor.screenRowForBufferRow(startRow),
            endRow: editor.screenRowForBufferRow(endRow),
            cls,
          });
        }
        ranges.sort((a, b) => a.startRow - b.startRow || a.endRow - b.endRow);
        const items = [];
        let lastItem = null;
        for (const { startRow, endRow, cls } of ranges) {
          if (lastItem && lastItem.cls === cls && startRow <= lastItem.end + 1) {
            lastItem.end = Math.max(lastItem.end, endRow);
          } else {
            if (lastItem) items.push(lastItem);
            lastItem = { row: startRow, end: endRow, cls };
          }
        }
        if (lastItem) items.push(lastItem);
        if (this.threshold && items.length > this.threshold) {
          return [];
        }
        return items;
      },
    };
  },
};
