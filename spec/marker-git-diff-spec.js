const { CompositeDisposable } = require("lumine");
const path = require("path");
const fs = require("fs");
const os = require("os");

describe("marker-git-diff", () => {
  let workspaceElement, mainModule, provider, projectPath, editor, layers;

  // The spec runner freezes setTimeout, so poll on animation frames instead.
  function waitFor(condition, { frames = 600 } = {}) {
    return new Promise((resolve, reject) => {
      let count = 0;
      const check = () => {
        let value;
        try {
          value = condition();
        } catch {
          value = null;
        }
        if (value) {
          resolve(value);
        } else if (++count > frames) {
          reject(new Error("Timed out waiting for condition"));
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  }

  function createLayer(layerEditor) {
    const layer = {
      editor: layerEditor,
      props: provider,
      cache: new Map(),
      items: [],
      disposables: new CompositeDisposable(),
      update: jasmine.createSpy("update"),
    };
    layers.push(layer);
    return layer;
  }

  // Attached the way a renderer's layer host attaches it, then waited out until
  // the repository resolved and the first diff landed.
  async function createInitializedLayer(layerEditor) {
    const layer = createLayer(layerEditor);
    provider.initialize(layer);
    await waitFor(() => layer.cache.has("diffs"));
    return layer;
  }

  async function refresh(...targets) {
    for (const layer of targets) {
      layer.update.calls.reset();
    }
    await mainModule.sourceForEditor(targets[0].editor).refresh();
    await waitFor(() => targets.every((layer) => layer.update.calls.count() > 0));
  }

  beforeEach(async () => {
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
    layers = [];

    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "marker-git-diff-"));
    fs.cpSync(path.join(__dirname, "fixtures", "working-dir"), projectPath, { recursive: true });
    fs.renameSync(path.join(projectPath, "git.git"), path.join(projectPath, ".git"));

    editor = await lumine.workspace.open(path.join(projectPath, "sample.js"));
    const pack = await lumine.packages.activatePackage("marker-git-diff");
    mainModule = pack.mainModule;
    provider = mainModule.provideMarkerLayer();
  });

  afterEach(() => {
    for (const layer of layers) {
      layer.disposables.dispose();
    }
    try {
      // Retries because Windows keeps a directory non-empty until the last handle on a
      // child closes, and `force` swallows only ENOENT.
      fs.rmSync(projectPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Windows can refuse to delete a repository the git host still holds
      // open; the OS cleans the temp directory eventually.
    }
  });

  describe("activation", () => {
    it("activates", () => {
      expect(lumine.packages.isPackageActive("marker-git-diff")).toBe(true);
    });
  });

  describe("marker.layer service provider", () => {
    it("describes the git-diff layer", () => {
      expect(provider.name).toBe("git-diff");
      expect(provider.position).toBe("right");
      expect(provider.merge).toBe(true);
      expect(provider.threshold).toBe("marker-git-diff.threshold");
      expect(typeof provider.initialize).toBe("function");
      expect(typeof provider.getItems).toBe("function");
    });

    it("resolves the repository owning the editor path", async () => {
      const layer = await createInitializedLayer(editor);
      const { repository } = mainModule.sourceForEditor(layer.editor);
      expect(repository).toBeTruthy();
      // Normalize separators, 8.3 aliases, and drive-letter case on Windows.
      const normalize = (p) => fs.realpathSync.native(p).replace(/\\/g, "/").toLowerCase();
      expect(normalize(repository.getWorkingDirectory())).toBe(normalize(projectPath));
    });

    it("resolves no repository for editors outside any repository", async () => {
      const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "marker-git-diff-out-"));
      const outsideEditor = await lumine.workspace.open(path.join(outsidePath, "plain.txt"));

      const layer = await createInitializedLayer(outsideEditor);
      expect(mainModule.sourceForEditor(outsideEditor).repository).toBe(null);
      expect(provider.getItems(layer)).toEqual([]);

      fs.rmSync(outsidePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("reports no markers for an unmodified file", async () => {
      const layer = await createInitializedLayer(editor);
      expect(layer.cache.get("diffs")).toEqual([]);
      expect(provider.getItems(layer)).toEqual([]);
    });

    it("marks modified lines", async () => {
      const layer = await createInitializedLayer(editor);

      editor.setTextInBufferRange(
        [
          [0, 0],
          [0, 1],
        ],
        "M",
      );
      await refresh(layer);

      expect(provider.getItems(layer)).toEqual([{ row: 0, end: 0, cls: "modified" }]);
    });

    it("marks added lines", async () => {
      const layer = await createInitializedLayer(editor);

      editor.setCursorBufferPosition([0, Infinity]);
      editor.insertNewline();
      editor.insertText("added-one");
      editor.insertNewline();
      editor.insertText("added-two");
      await refresh(layer);

      expect(provider.getItems(layer)).toEqual([{ row: 1, end: 2, cls: "added" }]);
    });

    it("marks the line preceding removed lines", async () => {
      const layer = await createInitializedLayer(editor);

      editor.setSelectedBufferRange([
        [1, 0],
        [2, 0],
      ]);
      editor.delete();
      await refresh(layer);

      expect(provider.getItems(layer)).toEqual([{ row: 0, end: 0, cls: "removed" }]);
    });

    // Git reports "ignored" as its own state, not as "untracked", so the
    // untracked early-out never covered it. The path here also carries a glob
    // metacharacter, which `git show <rev>:<path>` used to answer with HEAD's
    // commit message rather than reporting the path as absent — between them,
    // every line of an ignored file was marked.
    it("reports no markers for an ignored file", async () => {
      const ignoredPath = path.join(projectPath, "[e] dir", "out.log");
      fs.writeFileSync(path.join(projectPath, ".gitignore"), "*.log\n");
      fs.mkdirSync(path.join(projectPath, "[e] dir"));
      fs.writeFileSync(ignoredPath, "one\ntwo\nthree\n");

      const repository = await lumine.repositories.resolveForPath(ignoredPath);
      await repository.refreshStatusSnapshot();
      expect(repository.getStatusEntry(ignoredPath).ignored).toBe(true);
      expect(await repository.getFileAtRevision(ignoredPath, "HEAD")).toBeNull();

      const ignoredEditor = await lumine.workspace.open(ignoredPath);
      const layer = await createInitializedLayer(ignoredEditor);
      spyOn(repository, "getLineDiffsAsync").andCallThrough();
      ignoredEditor.setCursorBufferPosition([0, Infinity]);
      ignoredEditor.insertText("edited");
      await refresh(layer);

      expect(repository.getLineDiffsAsync).not.toHaveBeenCalled();
      expect(layer.cache.get("diffs")).toEqual([]);
      expect(provider.getItems(layer)).toEqual([]);
    });

    it("returns raw hunk ranges and leaves merging to the host", () => {
      const layer = createLayer(editor);
      layer.cache.set("diffs", [
        { newStart: 4, oldLines: 0, newLines: 2 },
        { newStart: 1, oldLines: 0, newLines: 3 },
        { newStart: 10, oldLines: 1, newLines: 1 },
      ]);

      expect(provider.getItems(layer)).toEqual([
        { row: 3, end: 4, cls: "added" },
        { row: 0, end: 2, cls: "added" },
        { row: 9, end: 9, cls: "modified" },
      ]);
    });
  });

  describe("the per-editor diff source", () => {
    it("destroys the source when the layer detaches", async () => {
      const layer = await createInitializedLayer(editor);
      expect(mainModule.sourceForEditor(editor)).toBeDefined();

      layer.disposables.dispose();
      expect(mainModule.sourceForEditor(editor)).toBeUndefined();
    });
  });
});
