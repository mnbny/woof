# Customize command

## Purpose and ownership

Customize creates or shows the developer's personal Woof configuration. The developer owns the settings. Customize remains available when configuration errors block normal CLI use.

## Creation and display

When configuration is absent, Customize creates a default file and reports its location. New configuration is private to the user. Existing content, formatting, and configuration symlinks remain unchanged.

The personal state directory is separate from the checkout. The developer can select another state directory. This choice leaves configuration in the default location unchanged.

Human output provides editor guidance. Agent output provides guidance for requested edits. Neither mode opens an editor or application. The display option shows saved configuration as formatted JSON without rewriting it.

Both caller modes use the same creation and display operations. Invalid arguments fail before those operations.

## Configuration contract and recovery

Configuration declares a schema version. Product settings and legacy migrations are not defined. Unknown fields and unsupported schema versions are invalid.

After a startup validation error, Customize can still report the configuration location or display content that it can parse. Malformed content can prevent display without preventing location reporting.

A successful recovery operation returns success despite the startup error. A failed creation or display returns failure. Recovery never replaces existing settings with defaults.
