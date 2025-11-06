import { NextResponse } from "next/server";
import sharp from "sharp"; // npm install sharp
import fs from "fs";
import path from "path";

// Load Studio instructions (excerpt to keep prompt size manageable)
let STUDIO_DOC = "";
try {
  const docPath = path.join(process.cwd(), "app", "instructions", "Studio_Full_Instructions.txt");
  STUDIO_DOC = fs.readFileSync(docPath, "utf8");
} catch (e) {
  // Non-fatal: continue without external doc (will still add core rules)
  console.warn("Studio instructions file not found or unreadable:", e?.message);
}
const STUDIO_EXCERPT = STUDIO_DOC ? STUDIO_DOC.slice(0, 6000) : "";

function mapAspectToProviderSize(aspectLabel) {
  // OpenAI supports '1024x1024', '1024x1536' (portrait), '1536x1024' (landscape), and 'auto'
  const label = (aspectLabel || "").toLowerCase();
  if (label.includes("9:16") || label.includes("vertical")) return "auto"; // we'll crop after
  if (label.includes("16:9") || label.includes("landscape")) return "1536x1024";
  if (label.includes("3:4") || label.includes("portrait")) return "1024x1536";
  if (label.includes("4:5") ) return "auto"; // not supported natively; crop after
  return "1024x1024";
}

function parseAspectNumeric(aspectLabel) {
  const label = (aspectLabel || "").toLowerCase();
  if (label.includes("9:16")) return { ratio: 9 / 16, code: "916" };
  if (label.includes("16:9")) return { ratio: 16 / 9, code: "169" };
  if (label.includes("4:5")) return { ratio: 4 / 5, code: "45" };
  if (label.includes("3:4")) return { ratio: 3 / 4, code: "34" };
  if (label.includes("1:1") || !aspectLabel) return { ratio: 1, code: "11" };
  // default 1:1
  return { ratio: 1, code: "11" };
}

function buildShootSheet(payload) {
  const skincare = payload.skincareMode === true || payload.skincareMode === "on";
  const filmStock = payload.filmStock || (skincare ? "Fujifilm Pro 400H" : "Kodak Portra 400");
  const lightingPreset = payload.lightingPreset || (skincare ? "Soft Pearl Light" : (payload.lightingMood || "Studio Edge Light"));
  const cameraModel = payload.cameras || (skincare ? "Canon EOS R5" : "Canon EOS R5");
  const lens = payload.lenses || (skincare ? "100mm Macro f/2.8" : "85mm f/1.4");
  const aperture = payload.fStops || (skincare ? "f/4" : "f/2.0");
  const iso = payload.iso || (skincare ? 200 : 200);
  const wb = payload.whiteBalance || (skincare ? "5200K" : "5300K");
  const angle = payload.angle || "3Quarter";
  const backdrop = payload.backdrop || "soft gradient backdrop in neutral tones";
  const env = payload.environment || "minimal studio set";
  const aspect = parseAspectNumeric(payload.aspectRatio).code;

  return {
    summary:
      `Shoot Sheet\n` +
      `- Models: ${payload.models || "1 female"} — Ethnicity: ${payload.ethnicities || "any"} — Age: ${payload.ageGroups || "25–30"}\n` +
      `- Makeup: face ${payload.makeupFace || "natural"}; eyes ${payload.makeupEyes || "defined"}; lips ${payload.makeupLips || "soft"}\n` +
      `- Hair: ${payload.hair?.colors || "medium brown"}; style ${payload.hairStyles || "loose waves"}; motion ${payload.hairMotion || "subtle"}\n` +
      `- Camera: ${cameraModel}; Lens: ${lens}; Aperture: ${aperture}\n` +
      `- Backdrop: ${backdrop}; Framing: ${payload.framing || "beauty close-up"}; Angle: ${angle}\n` +
      `- Lighting: ${lightingPreset}; Pose: ${payload.pose || "editorial relaxed"}\n` +
      `- Environment: ${env}\n` +
      `- Skincare Focus Mode: ${skincare ? "ON" : "OFF"}; Film Stock: ${filmStock}\n` +
      `- Aspect Ratio: ${payload.aspectRatio || "1:1"} (code ${aspect})\n` +
      `- References: Pose ${payload.poseRef ? "YES" : "NO"}, Wardrobe ${payload.wardrobeRef ? "YES" : "NO"}\n` +
      `\nUpload one pose reference (for body orientation) and an optional wardrobe reference (for fabric/texture cues).\nReply: "Looks good — generate image" to proceed.`,
    settings: { skincare, filmStock, lightingPreset, cameraModel, lens, aperture, iso, wb, angle, aspect },
  };
}

function buildEditorialCaption(lighting, film) {
  const lightPhrase = {
    "Soft Pearl Light": "soft pearl light wraps the face with gentle gradients",
    "Window Glow": "cool window glow carves delicate shadows",
    "Studio Edge Light": "rim-lit edges add a clean studio bite",
    "Golden Hour Fade": "warm dusk tones drift across the skin",
    "High-Key Clarity": "bright high-key sheen reveals honest texture",
    "Cinematic Contrast": "rich shadow depth sculpts an editorial profile",
  }[lighting] || "balanced studio light reveals natural texture";

  const filmPhrase = {
    "Kodak Portra 400": "with a Portra warmth and pastel rolloff",
    "Fujifilm Pro 400H": "with cool, clean whites in a 400H palette",
    "Kodak Ektar 100": "with vivid Ektar color and fine grain",
    "Ilford Delta 100": "in crisp monochrome with silken grain",
    "CineStill 800T": "with cinematic tungsten balance and soft halation",
  }[film] || "with a gentle filmic grain";

  return `${lightPhrase}, ${filmPhrase}.`;
}

function sanitizeName(s) {
  return String(s || "").replace(/[^A-Za-z0-9]+/g, "").slice(0, 20) || "Generic";
}

export async function POST(req) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.error("OpenAI image generation requested without OPENAI_API_KEY configured.");
      return NextResponse.json({ error: "Server configuration error: OpenAI API key is missing." }, { status: 500 });
    }

    const formData = await req.formData();
    const payload = JSON.parse(formData.get("payload") || "{}");
    const poseRef = formData.get("poseRef");
    const wardrobeRef = formData.get("wardrobeRef");
    payload.poseRef = !!poseRef;
    payload.wardrobeRef = !!wardrobeRef;

    // Step 1–3: Build Shoot Sheet and optionally short-circuit if confirmation not provided
    const shoot = buildShootSheet(payload);
    const confirmed = payload.confirm === true || payload.confirm === "true" || payload.action === "generate";
    const planningOnly = payload.action === "plan" || (!confirmed && payload.action !== "generate");
    if (planningOnly) {
      return NextResponse.json({
        status: "shoot-sheet",
        shootSheet: shoot.summary,
        settings: shoot.settings,
        message: "Review the Shoot Sheet. Upload a pose reference (required) and optional wardrobe reference. Reply with confirm=true to generate.",
      });
    }

    /* -------- Hair synthesis logic -------- */
    const hairDescription = `
Hair should appear as ${payload.hair?.colors || "medium brown"} 
${payload.hair?.streaks && payload.hair?.streaks !== "None" ? "with " + payload.hair?.streaks.toLowerCase() : ""},
styled in a ${payload.hairStyles || "loose waves"} look with ${payload.hairFinish || "natural texture"}.
Include realistic flyaways and ${payload.hairMotion || "subtle movement"}.
The hair color and streaks must match the exact tone description; do not reinterpret hue.
    `;

    /* -------- Realism & instruction directives -------- */
    const realismEnhancements = `
Core Standards (from Studio_Full_Instructions):
- Preserve pores, subtle blemishes, and natural tone variation; avoid plastic smoothing.
- Eyes must be expressive, iris in sharp focus with catchlights matching key light.
- Lighting includes real imperfections: edge glare, slight color temp offsets, uneven shadows.
- Hair edges stay soft with realistic stray strands and gentle depth falloff.
- Never imitate real people; outputs must be brand-safe and human-realistic.
    `;

    const realismStandards = `
You are a professional AI image-generation assistant specialized in ultra-realistic fashion/skincare portraits.
Render as high-end DSLR/medium-format photography with editorial realism and optical imperfections.
Follow the reference framework (Studio_Full_Instructions). Key sections: Skin realism, Eye behavior, Optical depth, Lighting presets, Skincare Focus Mode, Film Stock simulation, Pose and Wardrobe cue handling, Artifact correction.
    `;

    let visualGuidance = "";
    if (poseRef && wardrobeRef)
      visualGuidance =
        "Use the body composition and posture from the Pose Reference image, and adopt wardrobe texture and silhouette cues from the Wardrobe Reference image.";
    else if (poseRef)
      visualGuidance =
        "Use the body posture and head orientation from the Pose Reference image.";
    else if (wardrobeRef)
      visualGuidance =
        "Incorporate wardrobe silhouette, color, and fabric cues from the Wardrobe Reference image.";

    /* -------- Aspect Ratio Mapping (map to provider-supported sizes) -------- */
    // OpenAI Images API supports: '1024x1024', '1024x1536', '1536x1024', and 'auto'.
    const providerSize = mapAspectToProviderSize(payload.aspectRatio);
    const { ratio: targetRatio, code: aspectCode } = parseAspectNumeric(payload.aspectRatio);

    // Determine film/lighting from shoot sheet
    const filmStock = shoot.settings.filmStock;
    const lightingPreset = shoot.settings.lightingPreset;
    const aperture = String(shoot.settings.aperture || "f/2.0").replace(/^f\//i, "");
    const cameraModel = shoot.settings.cameraModel;
    const lens = shoot.settings.lens;
    const wb = shoot.settings.wb;
    const iso = shoot.settings.iso;
    const angle = shoot.settings.angle;

    /* -------- Final Prompt -------- */
    const prompt = `
${realismStandards}
${realismEnhancements}

Reference framework excerpt:\n${STUDIO_EXCERPT}

Skincare Focus Mode: ${shoot.settings.skincare ? "ON" : "OFF"}.
Film Stock Simulation: ${filmStock}.

Model: ${payload.models || "female"} (${payload.ethnicities || "any"}, age ${payload.ageGroups || "25–30"}).
${hairDescription}

Makeup: ${payload.makeupFace || "natural"}, eyes: ${payload.makeupEyes || "defined"}, lips: ${payload.makeupLips || "soft"}.
Wardrobe: ${payload.wardrobeStyles || "minimalist 90s"}, ${payload.wardrobeTextures || "satin / silk sheen"}.
Lighting Preset: ${lightingPreset}, tone: ${payload.toneStyle || "cinematic"}.
Camera: ${cameraModel} with ${lens} at f/${aperture}.
White Balance: ${wb}; ISO: ${iso}.
Angle: ${angle}; Backdrop: ${payload.backdrop || "soft gradient, neutral"}.
Aspect target: ${payload.aspectRatio || "1:1"}.

${visualGuidance}
The resulting image must maintain visible optical imperfections and realistic photographic texture.
    `;

    /* -------- Prepare API call -------- */
    const reqBody = {
      model: "gpt-image-1",
      prompt,
      size: providerSize,
    };

    // NOTE: uploading binary reference images directly to the Images Generations
    // endpoint is not supported with a JSON body. For now we ignore attachments
    // (poseRef / wardrobeRef) and only use them for prompt guidance above.
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(reqBody),
    });

    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      const fallback = await res.text();
      console.error("Failed to parse OpenAI response as JSON:", parseErr);
      return NextResponse.json({ error: "Unexpected response from image provider.", details: process.env.DEBUG_IMAGE === "true" ? fallback : undefined }, { status: 502 });
    }

    if (!res.ok) {
      const providerMessage = data?.error?.message || `Image provider returned status ${res.status}`;
      console.error("OpenAI image generation failed:", res.status, data);
      const status = res.status >= 400 && res.status < 600 ? res.status : 502;
      return NextResponse.json(
        {
          error: providerMessage,
          details: process.env.DEBUG_IMAGE === "true" ? data : undefined,
        },
        { status }
      );
    }

    const entry = data.data?.[0] || {};
    const imageUrl = entry.url;
    const b64 = entry.b64_json || entry.b64json || entry.b64;

    if (!imageUrl && !b64) {
      console.error("OpenAI response:", data);
      const details = process.env.DEBUG_IMAGE === "true" ? data : undefined;
      return NextResponse.json({ error: "No image returned", details }, { status: 500 });
    }

    /* -------- Automatic realism noise layer -------- */
    let buffer;
    if (imageUrl) {
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) throw new Error(`Failed fetching generated image URL: ${imgRes.status}`);
      buffer = Buffer.from(await imgRes.arrayBuffer());
    } else {
      // provider returned base64 directly
      buffer = Buffer.from(b64, "base64");
    }

    // Get image dimensions to generate a matching noise overlay
    let imgSharp = sharp(buffer);
    const meta = await imgSharp.metadata();
    const originalWidth = meta.width || 1024;
    const originalHeight = meta.height || 1024;

    // Optional server-side crop to requested aspect ratio
    if (targetRatio && originalWidth && originalHeight) {
      // Compute cover crop dimensions
      const desiredW = Math.min(originalWidth, Math.round(originalHeight * targetRatio));
      const desiredH = Math.min(originalHeight, Math.round(originalWidth / targetRatio));
      imgSharp = imgSharp.resize({ width: desiredW, height: desiredH, fit: "cover", position: "attention" });
    }

    // Materialize the pipeline so we can safely derive the post-resize dimensions
    const { data: preparedBuffer, info: preparedInfo } = await imgSharp.toBuffer({ resolveWithObject: true });
    const W = preparedInfo.width || originalWidth;
    const H = preparedInfo.height || originalHeight;
    imgSharp = sharp(preparedBuffer);

    // Create a simple random-grain noise buffer (grayscale) and composite it
    const noiseRaw = Buffer.alloc(W * H);
    for (let i = 0; i < noiseRaw.length; i++) {
      // small gaussian-like distributed noise via uniform random (good enough here)
      noiseRaw[i] = Math.floor(Math.random() * 32) + 112; // values around mid-gray
    }

    const noisePng = await sharp(noiseRaw, { raw: { width: W, height: H, channels: 1 } })
      .png()
      .toBuffer();

    const noiseBuffer = await imgSharp
      // Subtle clarity to restore microcontrast (helps "restore pores")
      .sharpen(0.6)
      .jpeg({ quality: 96 })
      .modulate({ brightness: 1.02, saturation: 1.02 })
      .composite([
        {
          input: noisePng,
          blend: "overlay",
          opacity: 0.12,
        },
      ])
      .toBuffer();

    const realismURL = `data:image/jpeg;base64,${noiseBuffer.toString("base64")}`;

    // -------- Build EXIF-style metadata & filename --------
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const filmCode = sanitizeName((filmStock || "Portra400").replace(/\s+/g, ""));
    const lightCode = sanitizeName((lightingPreset || "SoftPearl").replace(/\s+/g, ""));
    const angleCode = sanitizeName(angle || "3Quarter");
    const filename = `FASHION_${filmCode}_${lightCode}_${angleCode}_${aspectCode}_${dateStr}.jpg`;

    const exif = {
      Camera: cameraModel,
      Lens: lens,
      Aperture: `f/${aperture}`,
      ISO: iso,
      Lighting: lightingPreset,
      FilmStock: filmStock,
      WhiteBalance: wb,
      AspectRatio: payload.aspectRatio || "1:1",
      Angle: angle,
      Filename: filename,
      ColorProfile: "sRGB IEC61966-2.1",
      Shutter: "1/250",
      ExposureMode: "Manual",
    };

    const caption = buildEditorialCaption(lightingPreset, filmStock);

    // EXIF Block commands for user to apply locally if desired (JPEG true EXIF)
    const mac_linux_cmd = [
      "exiftool \\",
      "  -overwrite_original \\",
      "  -Make=\"Canon\" \\",
      "  -Model=\"EOS R5\" \\",
      `  -LensModel=\"${lens}\" \\`,
      `  -FNumber=${aperture} \\`,
      "  -ExposureTime=1/250 \\",
      `  -ISO=${iso} \\`,
      "  -ExposureProgram=\"Manual\" \\",
      `  -WhiteBalance=\"Daylight (${wb})\" \\`,
      "  -ColorSpace=\"sRGB\" \\",
      "  -ProfileDescription=\"sRGB IEC61966-2.1\" \\",
      "  -DateTimeOriginal=\"$(date '+%Y:%m:%d %H:%M:%S')\" \\",
      "  -Artist=\"Photo Model Render\" \\",
      "  -Copyright=\"© $(date +%Y) Photo Model Render\" \\",
      `  -ImageDescription=\"${filmStock} simulation | ${caption}\" \\`,
      `  \"${filename}\"`,
    ].join("\n");

    const windows_cmd = [
      "exiftool.exe ^\n",
      " -overwrite_original ^\n",
      " -Make=\"Canon\" ^\n",
      " -Model=\"EOS R5\" ^\n",
      ` -LensModel=\"${lens}\" ^\n`,
      ` -FNumber=${aperture} ^\n`,
      " -ExposureTime=1/250 ^\n",
      ` -ISO=${iso} ^\n`,
      " -ExposureProgram=\"Manual\" ^\n",
      ` -WhiteBalance=\"Daylight (${wb})\" ^\n`,
      " -ColorSpace=\"sRGB\" ^\n",
      " -ProfileDescription=\"sRGB IEC61966-2.1\" ^\n",
      " -DateTimeOriginal=\"%DATE:~10,4%:%DATE:~4,2%:%DATE:~7,2% %TIME:~0,8%\" ^\n",
      " -Artist=\"Photo Model Render\" ^\n",
      " -Copyright=\"© %DATE:~10,4% Photo Model Render\" ^\n",
      ` -ImageDescription=\"${filmStock} simulation | ${caption}\" ^\n`,
      ` \"${filename}\"`,
    ].join("");

    const exifBlock = {
      file_hint: filename,
      profile: "sRGB IEC61966-2.1",
      mac_linux_cmd,
      windows_cmd,
      notes: "For PNG, EXIF is stored as XMP + ICC; use JPEG for native EXIF.",
    };

    return NextResponse.json({ imageUrl: realismURL, filename, caption, exif, exifBlock });
  } catch (err) {
    console.error("Error generating image:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
