# Headless LibreOffice

Use this only when the presentation workflow needs LibreOffice conversion or rendering.

- Run `soffice` with `--headless --nologo --nodefault --nolockcheck --nofirststartwizard`.
- Create a unique profile for every invocation with `mktemp -d "$CANVAS_AGENT_TEMP_DIR/libreoffice-profile.XXXXXX"` and pass it as `-env:UserInstallation=file://<absolute-profile-path>`.
- Set `HOME` to a directory below `CANVAS_AGENT_TEMP_DIR`.
- Put the exported PDF and every rendered page below `CANVAS_AGENT_TEMP_DIR`; never write workspace files through `soffice`.
- Promote only the verified final artifact with `copy_path` or `move_path`.

Do not reuse a profile across concurrent invocations. Quote input and output paths.
