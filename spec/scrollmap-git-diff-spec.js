const { CompositeDisposable } = require("atom");
const path = require("path");
const fs = require("fs");
const os = require("os");

describe("scrollmap-git-diff", () => {
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
      cache: new Map(),
      disposables: new CompositeDisposable(),
      update: jasmine.createSpy("update"),
    };
    layers.push(layer);
    return layer;
  }

  async function createInitializedLayer(layerEditor) {
    const layer = createLayer(layerEditor);
    provider.initialize(layer);
    await waitFor(() => layer.update.calls.count() > 0);
    return layer;
  }

  async function refresh(layer) {
    layer.update.calls.reset();
    await layer.cache.get("refreshDiffs")();
    await waitFor(() => layer.update.calls.count() > 0);
  }

  beforeEach(async () => {
    workspaceElement = atom.views.getView(atom.workspace);
    jasmine.attachToDOM(workspaceElement);
    layers = [];

    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "scrollmap-git-diff-"));
    fs.cpSync(path.join(__dirname, "fixtures", "working-dir"), projectPath, { recursive: true });
    fs.renameSync(path.join(projectPath, "git.git"), path.join(projectPath, ".git"));

    editor = await atom.workspace.open(path.join(projectPath, "sample.js"));
    const pack = await atom.packages.activatePackage("scrollmap-git-diff");
    mainModule = pack.mainModule;
    provider = mainModule.provideScrollmap();
  });

  afterEach(() => {
    for (const layer of layers) {
      layer.disposables.dispose();
    }
    try {
      fs.rmSync(projectPath, { recursive: true, force: true });
    } catch {
      // Windows can refuse to delete a repository the git host still holds
      // open; the OS cleans the temp directory eventually.
    }
  });

  describe("activation", () => {
    it("activates", () => {
      expect(atom.packages.isPackageActive("scrollmap-git-diff")).toBe(true);
    });
  });

  describe("scrollmap service provider", () => {
    it("describes the git-diff layer", () => {
      expect(provider.name).toBe("git-diff");
      expect(provider.position).toBe("right");
      expect(provider.merge).toBe(true);
      expect(provider.threshold).toBe("scrollmap-git-diff.threshold");
      expect(typeof provider.initialize).toBe("function");
      expect(typeof provider.getItems).toBe("function");
    });

    it("resolves the repository owning the editor path", async () => {
      const layer = await createInitializedLayer(editor);
      const repository = layer.cache.get("repository");
      expect(repository).toBeTruthy();
      // Normalize separators, 8.3 aliases, and drive-letter case on Windows.
      const normalize = (p) => fs.realpathSync.native(p).replace(/\\/g, "/").toLowerCase();
      expect(normalize(repository.getWorkingDirectory())).toBe(normalize(projectPath));
    });

    it("caches no repository for editors outside any repository", async () => {
      const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), "scrollmap-git-diff-out-"));
      const outsideEditor = await atom.workspace.open(path.join(outsidePath, "plain.txt"));

      const layer = await createInitializedLayer(outsideEditor);
      expect(layer.cache.get("repository")).toBe(null);
      expect(provider.getItems(layer)).toEqual([]);

      fs.rmSync(outsidePath, { recursive: true, force: true });
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

    it("returns raw hunk ranges and leaves merging to the hub", () => {
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
});
