# Prompt rules — the owner's production frameworks (encode these as code, not as suggestions)

These come from the owner's own production experience. The prompt builder must apply them
automatically; an agent is not allowed to silently drop one.

## Language
- Seedance prompts are written in ENGLISH by default. Switch to Chinese only on explicit request.
- A Chinese prompt must stay under 3,900 characters; condense without changing meaning.
- Story dialogue for this project is ENGLISH (US audience).

## Seedance 2.5 master formula
[Creatives Description] + [One-sentence Summary] + [Specific Plot Description] + [Global Supplement/Ending]

- One-sentence summary = Subject + Location + Event + Theme/Style + Special camera movement.
- Plot block, per storyboard beat or timestamp:
  positive: picture content + camera movement + action + dialogue + SFX
  negative: unwanted elements, e.g. "no subtitles, no BGM".
- Global supplement: repeat the must-have elements through the whole clip — camera position,
  environment features, sound and atmosphere, lighting — and repeat the prohibited elements.

## Real-person / character formula (7 dimensions, every character prompt)
1. Age / ethnicity: specific age + nationality + style adjective + face-shape noun
2. Skin / texture: cool or warm tone + skin noun + texture adjective + "retain true micro pores and skin texture"
3. Facial details: eye shape + brow bone + nose bridge + lip shape + jawline (at least 3-4 points)
4. Eyes / soul: eye adjective + what the gaze conveys + underlying emotion
5. Hair: exact colour + condition/texture + hairstyle noun + interaction with environment
6. Clothing: pattern/cut + colour + garment noun + fabric/condition + wearing detail
7. Body / mood: skeleton and shoulders + composition/shot size + action and gaze + atmosphere

## Long-video formula (when a single generation must exceed ~10 s)
Module 1 multimodal reference layer: "Based on uploaded [type], strictly maintain consistency of
[face/features] in @Figure1, maintain consistency of [composition/spatial relationship] in
@Figure2, strictly lock character position".
Module 2 global settings / anti-collapse: environment + texture, visual style, shot language,
character styling, performance core, prohibited items (sound, subtitles, behaviour, collapse points).
Module 3 timestamp storyboard: [start-end seconds] + [phase] + [action/expression/scene/composition]
+ [emotional or camera note].

## Prohibited-items block (always append)
no subtitles, no BGM (unless wanted), no exaggerated movements, no fast cuts (if one-shot),
no extra dialogue generation, no runny nose / premature tears in emotional scenes, no AI-feel artifacts.

## Seedance 2.5 capabilities to exploit
- Video extension: 30 s base + 30 s extend (nested); ultra-long mode up to 180 s.
- Timestamp text control: name the exact second for an action or scene change.
- Multimodal reference: up to 30 images, 10 videos (30 s total), 10 audio (30 s total) per request.
- Improved negative-prompt compliance; multi-person reference no longer swaps faces as often.
- Native multi-language speech including English, Vietnamese, Japanese, Korean.

## Per-character hard rules
Stored per character in the registry (`character.rules`) and injected into every prompt that
includes that character. Example rules already in use by the owner: some characters never wear
rings — all ring-related wording must be stripped from their prompts. Vietnamese characters use
authentic Vietnamese facial features (wide rounded face, broad flat nose, warm golden-tan skin),
explicitly not pale East Asian or Western structures.

## Scene/environment blocks
Locations are written once as reusable blocks (interior/exterior, time of day, light direction
and colour, key set dressing, mood, camera height and depth of field) and reused verbatim across
every shot in that location, so continuity does not depend on the model remembering.
