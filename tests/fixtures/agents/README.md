JSONL streams are reconstructed from `spikes/agents/out/{claude,codex}-{draft,resume,cancel,isolation}.events.json`.
The recorded normalized tool/text/result events retain real session IDs, structured outputs,
cost and usage. Reconstruction maps them back to their documented provider envelopes.
`fake.mjs` replays these envelopes, replacing structured output for angle, edit and summary tasks.
Set BIP_FAKE_MODE=invalid|nonzero|slow to exercise failure/cancellation. Resume bypasses slow delay.
These files contain recorded project prose, not credentials. Never use the fake in production.
