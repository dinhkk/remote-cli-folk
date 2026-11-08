import os
import requests

def upload_catbox(file_path):
    print("Uploading to Catbox...")
    try:
        with open(file_path, 'rb') as f:
            resp = requests.post(
                'https://catbox.moe/user/api.php',
                data={'reqtype': 'fileupload'},
                files={'fileToUpload': f},
                timeout=180
            )
        if resp.status_code == 200:
            link = resp.text.strip()
            print("Catbox URL:", link)
            return link
        else:
            print(f"Catbox failed with code {resp.status_code}: {resp.text}")
    except Exception as e:
        print("Catbox error:", e)
    return None

def upload_tmpfiles(file_path):
    print("Uploading to TmpFiles...")
    try:
        with open(file_path, 'rb') as f:
            resp = requests.post(
                'https://tmpfiles.org/api/v1/upload',
                files={'file': f},
                timeout=180
            )
        if resp.status_code == 200:
            data = resp.json()
            url = data.get('data', {}).get('url')
            if url:
                direct_url = url.replace('tmpfiles.org/', 'tmpfiles.org/dl/')
                print("TmpFiles URL:", url)
                print("TmpFiles Direct URL:", direct_url)
                return url, direct_url
    except Exception as e:
        print("TmpFiles error:", e)
    return None, None

if __name__ == '__main__':
    video_path = 'video/output/remote-cli-motion-terminal.mp4'
    catbox_url = upload_catbox(video_path)
    tmp_url, tmp_dl = upload_tmpfiles(video_path)

    with open('video/motion_terminal_upload_links.txt', 'w', encoding='utf-8') as f:
        f.write(f"Catbox: {catbox_url}\n")
        f.write(f"TmpFiles: {tmp_url}\n")
        f.write(f"TmpFiles Direct: {tmp_dl}\n")
    print("Saved upload links.")
