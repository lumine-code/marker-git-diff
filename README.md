# marker-git-diff

Show git diff markers on the scrollbar and minimap.

A marker layer that renders added, modified and removed line hunks against the repository `HEAD`, drawn by [scrollmap](https://github.com/lumine-code/scrollmap) on the scrollbar and by [minimap](https://github.com/lumine-code/minimap) on the minimap.

## Features

- **Hunk markers**: shows added, modified and removed lines as overview markers.
- **State colors**: markers are colored by hunk state via theme colors.
- **Live updates**: follows repository status changes and editor edits.
- **Range merging**: adjacent hunks of the same state are merged into a single marker.
- **Threshold**: optionally hide all markers when the hunk count gets too large.

## Installation

To install `marker-git-diff` search for _marker-git-diff_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/marker-git-diff`.

## Customization

The style can be adjusted in the `styles.css` file, e.g. recolor markers of a given hunk state:

```css
.marker.marker-git-diff {
  &.modified {
    background-color: var(--text-color-modified);
  }
}
```

## Services

- **marker.layer** (`1.0.0`): provided to register the `git-diff` marker layer drawn by the editor's overview maps.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
