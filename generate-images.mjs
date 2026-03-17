/**
 * Gemini API 이미지 생성 스크립트
 * prompt/ 폴더의 .txt 파일을 읽어 Gemini로 이미지 생성 → images/ 폴더에 저장
 *
 * 사용법: node generate-images.mjs [파일명(옵션)]
 *   - 인자 없으면 전체 생성
 *   - 인자 있으면 해당 파일만 생성 (예: node generate-images.mjs proper-form-alignment)
 *
 * 환경변수: GEMINI_API_KEY (PushUps/.env에서 로드)
 */

import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = path.join(__dirname, "prompt");
const OUTPUT_DIR = path.join(__dirname, "images");
// Models to try in order (image-capable models)
const IMAGE_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-image-preview",
];

// .env 파일에서 GEMINI_API_KEY 로드
function loadApiKey() {
  // 환경변수 우선
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY.replace(/"/g, "");
  }
  // PushUps/.env에서 읽기
  const envFile = path.resolve(__dirname, "..", "PushUps", ".env");
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, "utf-8");
    const match = content.match(/GEMINI_API_KEY=["']?([^"'\r\n]+)["']?/);
    if (match) return match[1];
  }
  throw new Error("GEMINI_API_KEY not found. Set it as env var or in ../PushUps/.env");
}

// 프롬프트 파일에서 실제 프롬프트 텍스트 추출 (4번째 줄부터)
function extractPrompt(filePath) {
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  // 처음 3줄은 메타정보 (파일명, 아티클, 삽입위치), 4번째 줄은 빈 줄
  // 5번째 줄부터가 실제 프롬프트
  const promptLines = lines.slice(4).filter((l) => l.trim() !== "");
  return promptLines.join(" ").trim();
}

// 단일 이미지 생성
async function generateImage(ai, promptFile) {
  const baseName = path.basename(promptFile, ".txt");
  const outputPath = path.join(OUTPUT_DIR, `${baseName}.png`);

  // 이미 생성된 파일은 스킵
  if (fs.existsSync(outputPath)) {
    console.log(`⏭️  SKIP (exists): ${baseName}.png`);
    return { name: baseName, status: "skipped" };
  }

  const prompt = extractPrompt(promptFile);
  console.log(`\n🎨 Generating: ${baseName}.png`);
  console.log(`   Prompt: ${prompt.substring(0, 80)}...`);

  // 여러 모델 순서대로 시도
  for (const model of IMAGE_MODELS) {
    try {
      console.log(`   🔄 Trying model: ${model}`);
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseModalities: ["TEXT", "IMAGE"],
        },
      });

      let saved = false;
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const buffer = Buffer.from(part.inlineData.data, "base64");
          fs.writeFileSync(outputPath, buffer);
          console.log(`   ✅ Saved: ${outputPath} (model: ${model})`);
          saved = true;
          break;
        }
      }

      if (saved) {
        return { name: baseName, status: "success" };
      }

      // 텍스트 응답만 온 경우 → 다음 모델 시도
      const textParts = response.candidates[0].content.parts
        .filter((p) => p.text)
        .map((p) => p.text);
      console.log(`   ⚠️  No image from ${model}. Trying next...`);
      continue;
    } catch (err) {
      console.log(`   ⚠️  ${model} failed: ${err.message.substring(0, 80)}`);
      continue;
    }
  }

  console.error(`   ❌ All models failed for ${baseName}`);
  return { name: baseName, status: "error", error: "All models failed" };
}

// 메인
async function main() {
  const apiKey = loadApiKey();
  const ai = new GoogleGenAI({ apiKey });

  // 출력 폴더 생성
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 대상 파일 결정
  const targetArg = process.argv[2];
  let promptFiles;

  if (targetArg) {
    // 특정 파일만
    const fileName = targetArg.endsWith(".txt") ? targetArg : `${targetArg}.txt`;
    const filePath = path.join(PROMPT_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      console.error(`❌ File not found: ${filePath}`);
      process.exit(1);
    }
    promptFiles = [filePath];
  } else {
    // 전체
    promptFiles = fs
      .readdirSync(PROMPT_DIR)
      .filter((f) => f.endsWith(".txt"))
      .sort()
      .map((f) => path.join(PROMPT_DIR, f));
  }

  console.log(`📁 Prompt files: ${promptFiles.length}`);
  console.log(`📂 Output dir: ${OUTPUT_DIR}\n`);

  const results = [];
  for (const file of promptFiles) {
    const result = await generateImage(ai, file);
    results.push(result);

    // API rate limit 대비 — 이미지 생성 사이 2초 대기
    if (result.status === "success") {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // 결과 요약
  console.log("\n" + "=".repeat(50));
  console.log("📊 Results Summary:");
  const success = results.filter((r) => r.status === "success").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status !== "success" && r.status !== "skipped").length;
  console.log(`   ✅ Success: ${success}`);
  console.log(`   ⏭️  Skipped: ${skipped}`);
  console.log(`   ❌ Failed:  ${failed}`);

  if (failed > 0) {
    console.log("\nFailed items:");
    results
      .filter((r) => r.status !== "success" && r.status !== "skipped")
      .forEach((r) => console.log(`   - ${r.name}: ${r.error || r.response || "unknown"}`));
  }
}

main().catch(console.error);
