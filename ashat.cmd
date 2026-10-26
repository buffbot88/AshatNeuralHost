@echo off
rem Ashat engine alias — forwards to mistral.rs (the underlying inference engine).
rem Usage: ashat serve -f models\LFM2.5-2.6B-Q4_0.gguf --cpu --port 1234
mistralrs %*
