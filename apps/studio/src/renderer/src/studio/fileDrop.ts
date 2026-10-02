/**
 * Files dragged in from Explorer: on the welcome screen a photo (JPG, PNG, HEIC…) starts a new show
 * of that building; in the editor, pictures, videos and sound are imported into the show. The
 * editor's own drags (media cards onto areas) use their own data types and are left alone.
 */
import { createProjectFromPhoto } from "../space/actions.ts";
import { importMediaFiles } from "./media.ts";
import { useStudio } from "./store.ts";

const PHOTO = /\.(jpe?g|png|webp|bmp|heic|heif|hif)$/i;

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");

export const startFileDrop = (): (() => void) => {
  let depth = 0;
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "copy";
  };
  const enter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth++;
    document.body.classList.add("file-drag");
  };
  const leave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove("file-drag");
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove("file-drag");
    const paths = [...e.dataTransfer!.files].map((f) => window.be.files.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const s = useStudio.getState();
    if (s.screen === "welcome" || !s.project) {
      const photo = paths.find((p) => PHOTO.test(p));
      if (photo) void createProjectFromPhoto({ path: photo, dataUrl: "" });
      else s.toast({ kind: "info", text: "Drop a photo of your building (JPG, PNG or HEIC) to start." });
      return;
    }
    void importMediaFiles(paths);
  };
  document.addEventListener("dragover", over);
  document.addEventListener("dragenter", enter);
  document.addEventListener("dragleave", leave);
  document.addEventListener("drop", drop);
  return () => {
    document.removeEventListener("dragover", over);
    document.removeEventListener("dragenter", enter);
    document.removeEventListener("dragleave", leave);
    document.removeEventListener("drop", drop);
  };
};
