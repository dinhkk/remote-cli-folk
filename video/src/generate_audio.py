import asyncio
import os
import subprocess
import edge_tts
import wave
import math
import struct
import random

FFMPEG = 'C:/Users/tungh/AppData/Local/Programs/Python/Python310/lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe'

SCENES = [
    {
        'id': 'scene1',
        'text': 'Có một nghịch lý: AI càng làm được nhiều việc, thì ta lại càng bận hơn chứ chẳng được ngồi chơi. Thấy AI cày khỏe re, bạn bắt đầu khai thác triệt để, đốt token cho đỡ phí quota. Nhưng trong lúc nó chạy, bạn vẫn phải ngồi canh cho đúng chuẩn Human In The Loop.'
    },
    {
        'id': 'scene2',
        'text': 'Ngồi máy mãi thì đau lưng, bạn tìm cách remote qua điện thoại, chat chỉ đạo như nhắn tin với người yêu. Thế là ra quán trà đá cũng mở ra làm, tối trước khi ngủ cũng tranh thủ xem. Đang yên đang lành, tự nhiên lại gánh thêm việc!'
    },
    {
        'id': 'scene3',
        'text': 'Chưa hết, thấy cái PC ở nhà bỏ không, bạn lại lôi ra cày mấy ý tưởng thời sinh viên. Rồi thêm con laptop cũ, thêm một con VPS. Bạn gom hết vào một cái web remote, chuyển máy chỉ bằng một cái tab.'
    },
    {
        'id': 'scene4',
        'text': 'Thế là từ một project, giờ bạn ôm cùng lúc năm sáu cái. Danh sách máy dày đặc, hàng chục session nhảy liên tục từ sáng đến chiều.'
    },
    {
        'id': 'scene5',
        'text': 'Và rồi, đầu óc bắt đầu phân mảnh. Cả đàn AI thi nhau réo, hỏi ý kiến duyệt quyền. Bạn duyệt hết máy này sang máy khác, mà toàn nhắm mắt bấm Recommend vì chẳng kịp nghĩ sâu xa.'
    },
    {
        'id': 'scene6',
        'text': 'Cuối cùng từ sáng đến đêm, bạn chỉ ngồi làm bài thi trắc nghiệm. Bạn còn bận hơn cả lúc chưa có AI!'
    }
]

async def generate_voice_file(text, output_path, rate='+5%'):
    for attempt in range(5):
        try:
            print(f"Generating {output_path} (Attempt {attempt+1})...")
            communicate = edge_tts.Communicate(text, 'vi-VN-NamMinhNeural', rate=rate)
            await communicate.save(output_path)
            print(f"Success: {output_path}")
            return True
        except Exception as e:
            print(f"Error: {e}")
            await asyncio.sleep(2)
    raise RuntimeError(f"Failed to generate {output_path}")

def get_audio_duration(file_path):
    cmd = [FFMPEG, '-i', file_path]
    p = subprocess.run(cmd, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='ignore')
    for line in p.stderr.splitlines():
        if 'Duration:' in line:
            # Duration: 00:00:10.25,
            parts = line.split('Duration:')[1].split(',')[0].strip().split(':')
            hours = float(parts[0])
            minutes = float(parts[1])
            seconds = float(parts[2])
            return hours * 3600 + minutes * 60 + seconds
    return 10.0

def generate_sfx():
    sfx_dir = 'video/assets/audio/sfx'
    os.makedirs(sfx_dir, exist_ok=True)
    sample_rate = 44100

    # 1. Marker scribble sound (filtered noise modulated with sine bursts)
    marker_path = os.path.join(sfx_dir, 'marker.wav')
    duration = 0.6
    n_samples = int(sample_rate * duration)
    with wave.open(marker_path, 'w') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        frames = bytearray()
        prev = 0
        for i in range(n_samples):
            t = i / sample_rate
            # modulated burst
            envelope = math.sin(math.pi * t / duration) ** 2
            friction = (random.random() * 2 - 1) * 0.4
            # low pass smoothing
            val = prev * 0.6 + friction * 0.4
            prev = val
            sample = int(val * envelope * 12000)
            sample = max(-32768, min(32767, sample))
            frames.extend(struct.pack('<h', sample))
        wav.writeframes(frames)
    print("Generated marker.wav")

    # 2. Click / Tap sound (short snap)
    click_path = os.path.join(sfx_dir, 'click.wav')
    duration = 0.08
    n_samples = int(sample_rate * duration)
    with wave.open(click_path, 'w') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_samples):
            t = i / sample_rate
            decay = math.exp(-t * 60)
            tone = math.sin(2 * math.pi * 1200 * t) + 0.5 * math.sin(2 * math.pi * 2400 * t)
            sample = int(tone * decay * 18000)
            sample = max(-32768, min(32767, sample))
            frames.extend(struct.pack('<h', sample))
        wav.writeframes(frames)
    print("Generated click.wav")

    # 3. Notification Chime (two-tone pleasant bell)
    chime_path = os.path.join(sfx_dir, 'chime.wav')
    duration = 0.5
    n_samples = int(sample_rate * duration)
    with wave.open(chime_path, 'w') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_samples):
            t = i / sample_rate
            if t < 0.15:
                freq = 880.0 # A5
                decay = math.exp(-t * 12)
            else:
                freq = 1320.0 # E6
                decay = math.exp(-(t - 0.15) * 10)
            sample = int(math.sin(2 * math.pi * freq * t) * decay * 15000)
            sample = max(-32768, min(32767, sample))
            frames.extend(struct.pack('<h', sample))
        wav.writeframes(frames)
    print("Generated chime.wav")

    # 4. Pencil Checkmark sound (quick scratch)
    pencil_path = os.path.join(sfx_dir, 'pencil.wav')
    duration = 0.18
    n_samples = int(sample_rate * duration)
    with wave.open(pencil_path, 'w') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_samples):
            t = i / sample_rate
            noise = (random.random() * 2 - 1)
            decay = math.sin(math.pi * t / duration)
            sample = int(noise * decay * 10000)
            sample = max(-32768, min(32767, sample))
            frames.extend(struct.pack('<h', sample))
        wav.writeframes(frames)
    print("Generated pencil.wav")

def generate_lofi_bgm(total_duration, output_path):
    # Generates a mellow, warm lo-fi acoustic chord progression (Cmaj7 -> Am7 -> Dm7 -> G7)
    sample_rate = 44100
    n_samples = int(sample_rate * total_duration)
    chords = [
        [261.63, 329.63, 392.00, 493.88], # Cmaj7
        [220.00, 261.63, 329.63, 392.00], # Am7
        [293.66, 349.23, 440.00, 523.25], # Dm7
        [196.00, 246.94, 293.66, 349.23], # G7
    ]
    chord_len = 3.5 # seconds per chord

    with wave.open(output_path, 'w') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        frames = bytearray()
        for i in range(n_samples):
            t = i / sample_rate
            chord_idx = int(t / chord_len) % len(chords)
            chord = chords[chord_idx]
            t_in_chord = t % chord_len

            # Gentle strum / pad envelope
            env = math.exp(-t_in_chord * 0.8) * 0.7 + 0.3
            val = 0.0
            for note in chord:
                # Add fundamental + warm 2nd harmonic
                val += math.sin(2 * math.pi * note * t) * 0.6
                val += math.sin(4 * math.pi * note * t) * 0.2
            val /= len(chord)

            # Subtle vinyl warmth / tape hiss
            hiss = (random.random() * 2 - 1) * 0.015
            sample = int((val * env * 0.15 + hiss) * 32767) # gentle volume
            sample = max(-32768, min(32767, sample))
            frames.extend(struct.pack('<h', sample))
        wav.writeframes(frames)
    print(f"Generated BGM: {output_path} ({total_duration:.1f}s)")

async def main():
    audio_dir = 'video/assets/audio'
    os.makedirs(audio_dir, exist_ok=True)

    timeline = []
    current_time = 0.0

    for scene in SCENES:
        scene_file = os.path.join(audio_dir, f"{scene['id']}.mp3")
        await generate_voice_file(scene['text'], scene_file, rate='+16%')
        dur = get_audio_duration(scene_file)
        timeline.append({
            'id': scene['id'],
            'file': scene_file,
            'start': current_time,
            'duration': dur,
            'end': current_time + dur,
            'text': scene['text']
        })
        current_time += dur

    print("\n--- Audio Timeline ---")
    total_dur = 0
    for s in timeline:
        print(f"{s['id']}: start={s['start']:.2f}s, dur={s['duration']:.2f}s, end={s['end']:.2f}s")
        total_dur = s['end']
    print(f"Total Video Audio Duration: {total_dur:.2f} seconds (Target ~60s: PERFECT!)")

    # Save timeline to JSON
    import json
    with open('video/analysis/audio-timeline.json', 'w', encoding='utf-8') as f:
        json.dump(timeline, f, ensure_ascii=False, indent=2)

    # Generate SFX
    generate_sfx()

    # Generate Lo-fi BGM matched to total length + 1.5s padding
    bgm_path = os.path.join(audio_dir, 'bgm_lofi.wav')
    generate_lofi_bgm(total_dur + 2.0, bgm_path)

    # Concatenate voice segments into master voice track
    concat_list = os.path.join(audio_dir, 'concat.txt')
    with open(concat_list, 'w', encoding='utf-8') as f:
        for s in timeline:
            # write relative path with forward slashes
            f.write(f"file '{os.path.basename(s['file'])}'\n")

    master_voice = os.path.join(audio_dir, 'voiceover_master.wav')
    cmd = [
        FFMPEG, '-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
        '-c:a', 'pcm_s16le', 'voiceover_master.wav'
    ]
    subprocess.run(cmd, cwd=audio_dir, check=True)
    print(f"Created Master Voiceover: {master_voice}")

if __name__ == '__main__':
    asyncio.run(main())
