# scrollmap-git-diff

Show git diff markers on the scrollbar.

A layer package for [scrollmap](https://github.com/lumine-code/scrollmap) that renders added, modified and removed line hunks against the repository `HEAD`.

## Features

- **Hunk markers**: shows added, modified and removed lines as scrollbar markers.
- **State colors**: markers are colored by hunk state via theme colors.
- **Live updates**: follows repository status changes and editor edits.
- **Range merging**: adjacent hunks of the same state are merged into a single marker.
- **Threshold**: optionally hide all markers when the hunk count gets too large.

## Installation

To install `scrollmap-git-diff` search for _scrollmap-git-diff_ in the Install pane of the Lumine settings or run `lumine --install lumine-code/scrollmap-git-diff`.

## Customization

The style can be adjusted in the `styles.less` file, e.g. recolor markers of a given hunk state:

```less
.scrollmap .marker.marker-git {
  &.modified {
    background-color: var(--text-color-modified);
  }
}
```

## Services

- **scrollmap** (`1.0.0`): provided to register the `git` marker layer rendered on the editor scrollbar.

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
