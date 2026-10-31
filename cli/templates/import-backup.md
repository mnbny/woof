Backup of Woof home before this import: {{backup}}

The backup holds the root configuration, each file that it referenced, and each file that the import replaced. Its paths are relative to Woof home. If the user wants to undo the import, or if the report lists incomplete recovery, offer to restore the backup:

unzip -o {{backupArgument}} -d {{homeArgument}}

Restore only after the user approves. The backup does not hold the files that the import created. After a restore, the configuration no longer references them.
