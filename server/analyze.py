import sys
import json
import numpy as np
import librosa
import warnings

# Suppress librosa warnings for cleaner stdout
warnings.filterwarnings('ignore')

def analyze_track(file_path):
    try:
        # Load audio (use a lower sample rate for faster processing)
        y, sr = librosa.load(file_path, sr=22050)
        
        # 1. BPM and Beats
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
        beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
        
        # Determine a scalar tempo value (librosa may return an array)
        if isinstance(tempo, np.ndarray):
            bpm = float(tempo[0])
        else:
            bpm = float(tempo)
            
        # 2. Downbeats (heuristic: assume 4/4 time, start from the first strong beat)
        # For a robust approach we could use madmom, but with librosa we can just take every 4th beat.
        # Let's try to align it with energy peaks if possible, or just default to 1, 5, 9...
        downbeats = [beat_times[i] for i in range(0, len(beat_times), 4)]
        
        # 3. Energy curve & Sections
        # Compute RMS energy
        rms = librosa.feature.rms(y=y)[0]
        times = librosa.frames_to_time(np.arange(len(rms)), sr=sr)
        
        # Simple sectioning based on energy rolling average
        # Window of ~5 seconds
        win_length = int(sr * 5 / 512)
        if win_length == 0: win_length = 1
        
        smooth_rms = np.convolve(rms, np.ones(win_length)/win_length, mode='valid')
        smooth_times = times[:len(smooth_rms)]
        
        # Find major energy changes
        diffs = np.abs(np.diff(smooth_rms))
        threshold = np.mean(diffs) + 1.5 * np.std(diffs)
        change_points = np.where(diffs > threshold)[0]
        
        # Filter close change points to avoid too many sections (min 15 seconds apart)
        min_distance = int(sr * 15 / 512)
        filtered_points = [0]
        for p in change_points:
            if p - filtered_points[-1] > min_distance:
                filtered_points.append(p)
        filtered_points.append(len(smooth_rms) - 1)
        
        sections = []
        for i in range(len(filtered_points) - 1):
            start_idx = filtered_points[i]
            end_idx = filtered_points[i+1]
            sections.append({
                "start": float(smooth_times[start_idx]),
                "end": float(smooth_times[end_idx]),
                "energy": float(np.mean(smooth_rms[start_idx:end_idx]))
            })
            
        # 4. Transition points (e.g. low energy valleys or section boundaries)
        # We can propose section boundaries as good transition points
        transition_points = [s["start"] for s in sections if s["start"] > 10.0]

        result = {
            "bpm": bpm,
            "beats": beat_times,
            "downbeats": downbeats,
            "sections": sections,
            "transition_points": transition_points,
            "duration": float(librosa.get_duration(y=y, sr=sr))
        }
        
        print(json.dumps(result))
        
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}))
        sys.exit(1)
    
    analyze_track(sys.argv[1])
