/** Google Drive (through Drive for desktop): paths in My Drive, and project packages. */
import { describe, expect, it } from "vitest";
import { driveKind, driveRelative, driveResolve, myDriveCandidates, type PackageManifest, packagePlan, packageProblems, projectForPackage, projectFromPackage, safeFolderName } from "../src/shared/drive.ts";

describe("paths in My Drive", () => {
  it("finds Drive for desktop's drive letters first, then a mirrored folder", () => {
    const c = myDriveCandidates("C:\\Users\\me", "GH");
    expect(c).toEqual(["G:\\My Drive", "H:\\My Drive", "C:\\Users\\me\\Google Drive\\My Drive", "C:\\Users\\me\\My Drive", "C:\\Users\\me\\Google Drive"]);
  });

  it("gives a file's place in My Drive, whatever the drive letter or slashes", () => {
    expect(driveRelative("G:\\My Drive", "G:\\My Drive\\Effects library\\Ghosts\\a.mp4")).toBe("Effects library/Ghosts/a.mp4");
    expect(driveRelative("G:\\My Drive\\", "g:/my drive/Before Effects/Media/x.png")).toBe("Before Effects/Media/x.png");
    expect(driveRelative("G:\\My Drive", "G:\\My Drive")).toBe("");
    // Not inside My Drive (a local file, a folder that only starts the same).
    expect(driveRelative("G:\\My Drive", "D:\\Before Effects\\Media\\x.png")).toBeNull();
    expect(driveRelative("G:\\My Drive", "G:\\My Drive2\\x.png")).toBeNull();
    expect(driveRelative("G:\\My Drive", "G:\\My Drive\\..\\Other\\x.png")).toBeNull();
    expect(driveRelative("G:\\My Drive", "G:\\My Drive\\a\\..\\b\\.\\x.png")).toBe("b/x.png");
  });

  it("never resolves a place outside My Drive", () => {
    expect(driveResolve("G:\\My Drive", "Before Effects/Media")).toBe("G:\\My Drive\\Before Effects\\Media");
    expect(driveResolve("G:\\My Drive", "../Other")).toBeNull();
    expect(driveResolve("G:\\My Drive", "a/../../b")).toBeNull();
    expect(driveResolve("G:\\My Drive", "C:/Windows")).toBeNull();
  });

  it("knows what kind of file it is", () => {
    expect(driveKind("Ghosts.MP4")).toBe("video");
    expect(driveKind("house.heic")).toBe("image");
    expect(driveKind("thunder.wav")).toBe("audio");
    expect(driveKind("Show.beproj")).toBe("project");
    expect(driveKind("package.json")).toBe("package");
    expect(driveKind("notes.txt")).toBe("other");
  });

  it("makes names safe for a folder", () => {
    expect(safeFolderName('Porch: the "Big" Show?')).toBe("Porch the Big Show");
    expect(safeFolderName("CON")).toBe("Project");
    expect(safeFolderName("  ...  ")).toBe("Project");
  });
});

describe("project packages", () => {
  const project = {
    id: "prj",
    assets: {
      a: { id: "a", path: "D:\\Media\\prj\\organ.mp4", audioPath: "D:\\Media\\prj\\organ.audio.wav" },
      b: { id: "b", path: "D:\\Media\\other\\organ.mp4" },
      c: { id: "c", path: "D:\\Media\\prj\\gone.png" },
      d: { id: "d", path: "D:\\Media\\prj\\organ.mp4" },
    },
  };
  const exists = (p: string) => !p.includes("gone");

  it("packs each file once, numbering clashing names, leaving out missing files", () => {
    const plan = packagePlan(Object.values(project.assets), exists);
    expect([...plan.entries()]).toEqual([
      ["D:\\Media\\prj\\organ.mp4", "media/organ.mp4"],
      ["D:\\Media\\prj\\organ.audio.wav", "media/organ.audio.wav"],
      ["D:\\Media\\other\\organ.mp4", "media/organ (2).mp4"],
    ]);
  });

  it("points the packed project at the package's files and back at local copies when opened", () => {
    const plan = packagePlan(Object.values(project.assets), exists);
    const packed = projectForPackage(project, plan);
    expect(packed.assets.a).toEqual({ id: "a", path: "media/organ.mp4", audioPath: "media/organ.audio.wav" });
    expect(packed.assets.b.path).toBe("media/organ (2).mp4");
    expect(packed.assets.c.path).toBe("D:\\Media\\prj\\gone.png"); // left as it was (reported missing on open)
    expect(packed.assets.d.path).toBe("media/organ.mp4");
    const opened = projectFromPackage(packed, (rel) => `E:\\Local\\${rel.slice("media/".length)}`);
    expect(opened.assets.a).toEqual({ id: "a", path: "E:\\Local\\organ.mp4", audioPath: "E:\\Local\\organ.audio.wav" });
    expect(opened.assets.b.path).toBe("E:\\Local\\organ (2).mp4");
  });

  it("notices a package that hasn't fully arrived", () => {
    const m: PackageManifest = { kind: "before-effects-package", version: 1, name: "Show", project: "Show.beproj", createdAt: "", files: [{ rel: "media/a.mp4", size: 10 }, { rel: "media/b.png", size: 5 }, { rel: "Show.beproj", size: 3 }] };
    const sizes: Record<string, number> = { "media/a.mp4": 10, "media/b.png": 2 };
    expect(packageProblems(m, (r) => sizes[r] ?? null)).toEqual(["media/b.png is 2 bytes, expected 5", "Show.beproj is missing"]);
  });
});
