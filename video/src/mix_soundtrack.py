import wave
import struct
import math
import os

FFMPEG = 'C:/Users/tungh/AppData/Local/Programs/Python/Python310/lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe'

def load_wav_mono(path, target_sr=24000):
    # Use ffmpeg to normalize any audio to 24000Hz 16-bit mono wav
    tmp_path = path + '.tmp.wav'
    import subprocess
    cmd = [
        FFMPEG, '-y', '-i', path,
        '-ar', str(target_sr),
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        tmp_path
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    with wave.open(tmp_path, 'r') as w:
        n = w.getnframes()
        raw = w.readframes(n)
        samples = list(struct.unpack(f'<{n}h', raw))
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    return samples

def build_soundtrack():
    print("Building master audio with voice, BGM, and timed SFX...")
    SR = 24000

    # 1. Load Voiceover
    voice_samples = load_wav_mono('video/assets/audio/voiceover_master.wav', SR)
    total_samples = len(voice_samples) + int(SR * 2.5) # + 2.5s tail for outro

    # Master buffer (32-bit float for mixing)
    master = [0.0] * total_samples

    # Add voice (volume 1.0)
    for i, s in enumerate(voice_samples):
        master[i] += s

    # 2. Add Lo-fi BGM (volume 0.12, fade out last 3 seconds)
    bgm_samples = load_wav_mono('video/assets/audio/bgm_lofi.wav', SR)
    bgm_vol = 0.12
    for i in range(total_samples):
        bgm_val = bgm_samples[i % len(bgm_samples)]
        # Fade out in the last 3 seconds
        t_left = (total_samples - i) / SR
        fade = min(1.0, t_left / 3.0)
        master[i] += bgm_val * bgm_vol * fade

    # 3. Add Timed SFX
    sfx_marker = load_wav_mono('video/assets/audio/sfx/marker.wav', SR)
    sfx_click = load_wav_mono('video/assets/audio/sfx/click.wav', SR)
    sfx_chime = load_wav_mono('video/assets/audio/sfx/chime.wav', SR)
    sfx_pencil = load_wav_mono('video/assets/audio/sfx/pencil.wav', SR)

    sfx_schedule = [
        (1.0, sfx_marker, 0.4),
        (15.0, sfx_chime, 0.35),
        (28.0, sfx_click, 0.5),
        (37.0, sfx_click, 0.5),
        (42.0, sfx_click, 0.6), # tab switch click
        (43.5, sfx_click, 0.6),
        (48.5, sfx_chime, 0.5), # alert chime
        (53.0, sfx_click, 0.7), # spam click recommend
        (53.3, sfx_click, 0.7),
        (53.6, sfx_click, 0.7),
        (53.9, sfx_click, 0.7),
        (54.2, sfx_click, 0.7),
        (59.5, sfx_pencil, 0.6), # pencil fill
        (60.2, sfx_pencil, 0.6),
        (60.8, sfx_pencil, 0.6),
    ]

    for start_t, sfx_data, vol in sfx_schedule:
        idx = int(start_t * SR)
        for j, s in enumerate(sfx_data):
            if idx + j < total_samples:
                master[idx + j] += s * vol

    # 4. Clip & Export to 16-bit PCM WAV
    out_path = 'video/assets/audio/soundtrack_master.wav'
    with wave.open(out_path, 'w') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for sample in master:
            clamped = max(-32768, min(32767, int(sample)))
            frames.extend(struct.pack('<h', clamped))
        w.writeframes(frames)

    print(f"Master Soundtrack Created: {out_path} ({total_samples / SR:.2f}s)")

if __name__ == '__main__':
    build_soundtrack()
