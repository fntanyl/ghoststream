#!/usr/bin/env python3
"""
GhostStream Admin GUI - Interfaccia grafica per caricare video

Doppio click su questo file per aprirlo, oppure:
  python3 ingest_gui.py
"""

import os
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from pathlib import Path

# Carica .env prima di tutto
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Verifica che le dipendenze siano installate
try:
    from ingest import main as ingest_main, ffprobe, choose_cap, is_mp4_container
except ImportError as e:
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror(
        "Dipendenze mancanti",
        f"Errore: {e}\n\nEsegui nel terminale:\npip3 install -r requirements.txt"
    )
    sys.exit(1)


class IngestGUI:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("GhostStream - Carica Video")
        self.root.geometry("600x500")
        self.root.resizable(True, True)
        
        # Variabili
        self.file_path = tk.StringVar()
        self.title_var = tk.StringVar()
        self.tags_var = tk.StringVar()
        self.skip_compress = tk.BooleanVar(value=False)
        self.is_uploading = False
        
        self.create_widgets()
        
    def create_widgets(self):
        # Frame principale con padding
        main = ttk.Frame(self.root, padding=20)
        main.pack(fill=tk.BOTH, expand=True)
        
        # Titolo
        title_label = ttk.Label(main, text="🎬 GhostStream Admin", font=("Helvetica", 18, "bold"))
        title_label.pack(pady=(0, 20))
        
        # === File Video ===
        file_frame = ttk.LabelFrame(main, text="1. Seleziona Video", padding=10)
        file_frame.pack(fill=tk.X, pady=5)
        
        file_entry = ttk.Entry(file_frame, textvariable=self.file_path, state="readonly")
        file_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 10))
        
        browse_btn = ttk.Button(file_frame, text="Sfoglia...", command=self.browse_file)
        browse_btn.pack(side=tk.RIGHT)
        
        # Info video
        self.video_info_label = ttk.Label(main, text="", foreground="gray")
        self.video_info_label.pack(anchor=tk.W, pady=(5, 10))
        
        # === Titolo ===
        title_frame = ttk.LabelFrame(main, text="2. Titolo del Video", padding=10)
        title_frame.pack(fill=tk.X, pady=5)
        
        title_entry = ttk.Entry(title_frame, textvariable=self.title_var)
        title_entry.pack(fill=tk.X)
        
        # === Tags ===
        tags_frame = ttk.LabelFrame(main, text="3. Tag (separati da virgola)", padding=10)
        tags_frame.pack(fill=tk.X, pady=5)
        
        tags_entry = ttk.Entry(tags_frame, textvariable=self.tags_var)
        tags_entry.pack(fill=tk.X)
        
        ttk.Label(tags_frame, text="Esempio: vacanze, estate, mare", foreground="gray").pack(anchor=tk.W)
        
        # === Opzioni ===
        options_frame = ttk.LabelFrame(main, text="4. Opzioni", padding=10)
        options_frame.pack(fill=tk.X, pady=5)
        
        skip_check = ttk.Checkbutton(
            options_frame, 
            text="Skip compressione (usa solo se il video è già ottimizzato)",
            variable=self.skip_compress
        )
        skip_check.pack(anchor=tk.W)
        
        # === Pulsanti ===
        btn_frame = ttk.Frame(main)
        btn_frame.pack(fill=tk.X, pady=20)
        
        self.upload_btn = ttk.Button(
            btn_frame, 
            text="🚀 Carica Video",
            command=self.start_upload,
            style="Accent.TButton"
        )
        self.upload_btn.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=5)
        
        self.test_btn = ttk.Button(
            btn_frame,
            text="🧪 Test (Dry Run)",
            command=self.start_dry_run
        )
        self.test_btn.pack(side=tk.RIGHT, expand=True, fill=tk.X, padx=5)
        
        # === Progress ===
        self.progress = ttk.Progressbar(main, mode="indeterminate")
        self.progress.pack(fill=tk.X, pady=5)
        
        # === Log ===
        log_frame = ttk.LabelFrame(main, text="Log", padding=10)
        log_frame.pack(fill=tk.BOTH, expand=True, pady=5)
        
        self.log_text = tk.Text(log_frame, height=8, state=tk.DISABLED, font=("Courier", 10))
        self.log_text.pack(fill=tk.BOTH, expand=True)
        
        scrollbar = ttk.Scrollbar(self.log_text, command=self.log_text.yview)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        self.log_text.config(yscrollcommand=scrollbar.set)
    
    def log(self, message: str):
        self.log_text.config(state=tk.NORMAL)
        self.log_text.insert(tk.END, message + "\n")
        self.log_text.see(tk.END)
        self.log_text.config(state=tk.DISABLED)
        self.root.update_idletasks()
    
    def browse_file(self):
        filetypes = [
            ("Video", "*.mp4 *.mov *.avi *.mkv *.webm *.m4v"),
            ("Tutti i file", "*.*")
        ]
        path = filedialog.askopenfilename(filetypes=filetypes)
        if path:
            self.file_path.set(path)
            self.analyze_video(path)
    
    def analyze_video(self, path: str):
        try:
            info = ffprobe(Path(path))
            cap = choose_cap(info.duration_seconds)
            duration_min = int(info.duration_seconds // 60)
            duration_sec = int(info.duration_seconds % 60)
            
            compliant = is_mp4_container(info.container) and info.video_codec == "h264"
            status = "✅ Già ottimizzato" if compliant else "⚠️ Verrà ricodificato"
            
            self.video_info_label.config(
                text=f"📊 {info.width}x{info.height} | {duration_min}:{duration_sec:02d} | {info.video_codec.upper()} | Cap: {cap}p | {status}"
            )
        except Exception as e:
            self.video_info_label.config(text=f"❌ Errore analisi: {e}")
    
    def validate(self) -> bool:
        if not self.file_path.get():
            messagebox.showwarning("Attenzione", "Seleziona un file video")
            return False
        if not self.title_var.get().strip():
            messagebox.showwarning("Attenzione", "Inserisci un titolo")
            return False
        if not self.tags_var.get().strip():
            messagebox.showwarning("Attenzione", "Inserisci almeno un tag")
            return False
        return True
    
    def start_upload(self):
        if self.validate():
            self.run_ingest(dry_run=False)
    
    def start_dry_run(self):
        if self.validate():
            self.run_ingest(dry_run=True)
    
    def run_ingest(self, dry_run: bool):
        if self.is_uploading:
            return
        
        self.is_uploading = True
        self.upload_btn.config(state=tk.DISABLED)
        self.test_btn.config(state=tk.DISABLED)
        self.progress.start(10)
        
        # Pulisci log
        self.log_text.config(state=tk.NORMAL)
        self.log_text.delete(1.0, tk.END)
        self.log_text.config(state=tk.DISABLED)
        
        # Esegui in thread separato per non bloccare UI
        thread = threading.Thread(target=self._do_ingest, args=(dry_run,), daemon=True)
        thread.start()
    
    def _do_ingest(self, dry_run: bool):
        try:
            self.log(f"{'🧪 TEST MODE' if dry_run else '🚀 UPLOAD'} - Inizio...")
            
            # Costruisci argv come se fosse da linea di comando
            argv = [
                "ingest.py",
                "--file", self.file_path.get(),
                "--title", self.title_var.get().strip(),
                "--tags", self.tags_var.get().strip(),
            ]
            if self.skip_compress.get():
                argv.append("--skip-compress")
            if dry_run:
                argv.append("--dry-run")
            
            # Sovrascrivi sys.argv e lancia
            old_argv = sys.argv
            sys.argv = argv
            
            try:
                result = ingest_main()
                if result == 0:
                    self.log("✅ Completato con successo!")
                    if not dry_run:
                        self.root.after(0, lambda: messagebox.showinfo(
                            "Successo", 
                            "Video caricato con successo!\n\nOra puoi vederlo nella Mini App."
                        ))
                else:
                    self.log(f"❌ Errore (codice {result})")
            except Exception as inner_e:
                inner_msg = str(inner_e)
                self.log(f"❌ Errore interno: {inner_msg}")
                self.root.after(0, lambda msg=inner_msg: messagebox.showerror("Errore", msg))
            finally:
                sys.argv = old_argv
                
        except Exception as e:
            error_msg = str(e)
            self.log(f"❌ Errore: {error_msg}")
            self.root.after(0, lambda msg=error_msg: messagebox.showerror("Errore", msg))
        finally:
            self.root.after(0, self._upload_finished)
    
    def _upload_finished(self):
        self.is_uploading = False
        self.upload_btn.config(state=tk.NORMAL)
        self.test_btn.config(state=tk.NORMAL)
        self.progress.stop()


def main():
    # Verifica env vars essenziali
    required = ["R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
    missing = [v for v in required if not os.getenv(v)]
    
    if missing:
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(
            "Configurazione mancante",
            f"Variabili d'ambiente mancanti nel file .env:\n\n" + "\n".join(missing) +
            "\n\nAssicurati che il file .env sia nella stessa cartella."
        )
        sys.exit(1)
    
    root = tk.Tk()
    
    # Stile più moderno
    style = ttk.Style()
    if "aqua" in style.theme_names():
        style.theme_use("aqua")
    elif "clam" in style.theme_names():
        style.theme_use("clam")
    
    app = IngestGUI(root)
    root.mainloop()


if __name__ == "__main__":
    main()

