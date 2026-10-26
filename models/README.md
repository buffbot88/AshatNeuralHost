# Models

Drop **any `.gguf` file** in this folder — Ashat Neural Host discovers it
automatically. No restart, no config edit: pick it in **Settings → Model**.

## Recommended: Liquid AI LFM2.5-2.6B (QAD Q4_0)

The default stack is tuned for this model (hybrid `lfm2` arch, CPU-friendly):

1. Download `LFM2.5-2.6B-QAD-Q4_0.gguf` (~1.5 GB) from
   **https://huggingface.co/LiquidAI/LFM2.5-2.6B-GGUF**
2. Save it in this folder (any filename ending in `.gguf` works).
3. `npm start` → open the site → the engine loads it on boot.

> Weights are git-ignored (`*.gguf`), so cloning ANH never downloads models.
> Other LFM2.5 sizes (1.2B, 8B-A1B) and other GGUFs the engine supports work
> too — the Settings page lists whatever lands here.
