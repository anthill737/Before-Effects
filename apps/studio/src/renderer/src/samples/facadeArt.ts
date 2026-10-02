/**
 * Procedural "photo" of the sample town hall, drawn deterministically so the sample needs no
 * binary assets. It acts as the surface colour for the "On the building" preview.
 */
import { rand01 } from "@be/core";
import { SAMPLE_H, SAMPLE_W, sampleRegions } from "./facade.ts";

export const drawFacade = (): OffscreenCanvas => {
  const c = new OffscreenCanvas(SAMPLE_W, SAMPLE_H);
  const g = c.getContext("2d")!;
  // Sky and ground
  const sky = g.createLinearGradient(0, 0, 0, SAMPLE_H);
  sky.addColorStop(0, "#5d6f86");
  sky.addColorStop(1, "#8e9aa6");
  g.fillStyle = sky;
  g.fillRect(0, 0, SAMPLE_W, SAMPLE_H);
  g.fillStyle = "#4a4a48";
  g.fillRect(0, 1000, SAMPLE_W, 80);

  // Gable roof
  g.fillStyle = "#6b4a3c";
  g.beginPath();
  g.moveTo(200, 330);
  g.lineTo(960, 96);
  g.lineTo(1720, 330);
  g.closePath();
  g.fill();
  g.strokeStyle = "#d9cfbf";
  g.lineWidth = 14;
  g.stroke();
  // Pediment interior
  g.fillStyle = "#cfc2ad";
  g.beginPath();
  g.moveTo(300, 322);
  g.lineTo(960, 130);
  g.lineTo(1620, 322);
  g.closePath();
  g.fill();
  // Round window in the pediment
  g.fillStyle = "#33404c";
  g.beginPath();
  g.arc(960, 240, 46, 0, Math.PI * 2);
  g.fill();

  // Stone wall with block courses
  g.fillStyle = "#c9b99f";
  g.fillRect(260, 320, 1400, 680);
  for (let row = 0; row < 26; row++) {
    const y = 320 + row * 26;
    const off = row % 2 ? 0 : 45;
    for (let x = 260 - off; x < 1660; x += 90) {
      const v = rand01(7, row, x) * 26 - 13;
      g.fillStyle = `rgb(${201 + v},${185 + v},${159 + v})`;
      g.fillRect(Math.max(260, x + 2), y + 2, Math.min(86, 1660 - Math.max(260, x + 2)), 22);
    }
  }
  // Cornice
  g.fillStyle = "#e3d8c6";
  g.fillRect(240, 312, 1440, 18);
  g.fillRect(250, 640, 1420, 12);

  for (const r of sampleRegions()) {
    const pts = r.path.vertices;
    if (r.kind === "window") {
      const x = pts[0]!.p[0];
      const y = pts[0]!.p[1];
      // Frame, sill and glass
      g.fillStyle = "#efe7da";
      g.fillRect(x - 10, y - 10, 190, 230);
      const glass = g.createLinearGradient(x, y, x + 170, y + 210);
      glass.addColorStop(0, "#3b4b5c");
      glass.addColorStop(1, "#1f2933");
      g.fillStyle = glass;
      g.fillRect(x, y, 170, 210);
      g.fillStyle = "#efe7da";
      g.fillRect(x + 81, y, 8, 210);
      g.fillRect(x, y + 100, 170, 8);
      g.fillStyle = "#d8ccb8";
      g.fillRect(x - 18, y + 210, 206, 14);
    } else if (r.kind === "door") {
      g.fillStyle = "#efe7da";
      g.beginPath();
      g.moveTo(866, 1000);
      g.lineTo(866, 760);
      g.arc(960, 760, 94, Math.PI, 0);
      g.lineTo(1054, 1000);
      g.closePath();
      g.fill();
      g.fillStyle = "#5a3a26";
      g.beginPath();
      g.moveTo(880, 1000);
      g.lineTo(880, 760);
      g.arc(960, 760, 80, Math.PI, 0);
      g.lineTo(1040, 1000);
      g.closePath();
      g.fill();
      g.fillStyle = "#3d2718";
      g.fillRect(957, 700, 6, 300);
    } else if (r.kind === "column") {
      const x = pts[0]!.p[0];
      const col = g.createLinearGradient(x, 0, x + 52, 0);
      col.addColorStop(0, "#d8cdb9");
      col.addColorStop(0.5, "#f1e9db");
      col.addColorStop(1, "#c4b69e");
      g.fillStyle = col;
      g.fillRect(x, 330, 52, 670);
    }
  }
  // Steps
  g.fillStyle = "#b9ad99";
  g.fillRect(820, 1000, 280, 26);
  g.fillRect(790, 1026, 340, 26);
  return c;
};

export const facadeBlob = async (): Promise<Blob> => drawFacade().convertToBlob({ type: "image/png" });
