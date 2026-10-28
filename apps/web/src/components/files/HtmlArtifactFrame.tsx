import {
  HTML_ARTIFACT_SANDBOX,
  htmlArtifactDocument,
  htmlRenderThemeMessage,
} from "@t3tools/shared/htmlRender";
import { useEffect, useRef, useState } from "react";

import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";

export function HtmlArtifactFrame(props: { title: string; html: string }) {
  const theme = useHtmlRenderTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [srcDoc] = useState(() => htmlArtifactDocument(props.html, theme));
  // oxlint-disable-next-line t3code/react-effect-budget -- Synchronize theme values into the opaque frame without accepting requests from it.
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  }, [theme]);
  return (
    <iframe
      ref={frame}
      title={props.title}
      srcDoc={srcDoc}
      sandbox={HTML_ARTIFACT_SANDBOX}
      referrerPolicy="no-referrer"
      onLoad={() => frame.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*")}
      className="min-h-0 flex-1 border-0 bg-background"
    />
  );
}
