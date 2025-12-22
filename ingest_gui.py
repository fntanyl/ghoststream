#!/usr/bin/env python3
"""
GhostStream Admin GUI - Interfaccia grafica per caricare video (Singolo + Bulk)

Features:
- Tab "Singolo": Upload di un video alla volta (workflow originale)
- Tab "Bulk": Upload multiplo con tabella editabile
- Ottimizzazione Apple Silicon (M1/M2/M3)
- Progress tracking e gestione errori

Doppio click su questo file per aprirlo, oppure:
  python3 ingest_gui.py
"""

import os
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from pathlib import Path
from typing import List, Optional, Callable
from dataclasses import dataclass
import re

# Carica .env prima di tutto
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# Verifica che le dipendenze siano installate
try:
    from ingest import (
        ingest_video, 
        IngestResult,
        ffprobe, 
        choose_cap, 
        is_mp4_container,
        is_apple_silicon,
    )
except ImportError as e:
    root = tk.Tk()
    root.withdraw()
    messagebox.showerror(
        "Dipendenze mancanti",
        f"Errore: {e}\n\nEsegui nel terminale:\npip3 install -r requirements.txt"
    )
    sys.exit(1)


@dataclass
class VideoItem:
    """Rappresenta un video nella coda di upload."""
    file_path: str
    title: str
    tags: str
    status: str = "⏳ In coda"
    error: Optional[str] = None


def clean_filename_to_title(filename: str) -> str:
    """
    Converte un nome file in un titolo leggibile.
    Es: "video_divertente_01.mp4" -> "Video Divertente 01"
    """
    # Rimuovi estensione
    name = Path(filename).stem
    # Sostituisci underscore e trattini con spazi
    name = re.sub(r'[_\-]+', ' ', name)
    # Rimuovi numeri iniziali tipo "001_" 
    name = re.sub(r'^\d+\s*', '', name)
    # Capitalizza ogni parola
    name = name.title()
    # Pulisci spazi multipli
    name = re.sub(r'\s+', ' ', name).strip()
    return name if name else Path(filename).stem


class EditableTreeview(ttk.Treeview):
    """Treeview con celle editabili per titolo e tag."""
    
    def __init__(self, parent, **kwargs):
        super().__init__(parent, **kwargs)
        self._entry = None
        self._editing_item = None
        self._editing_column = None
        
        self.bind('<Double-1>', self._on_double_click)
        self.bind('<Escape>', self._cancel_edit)
    
    def _on_double_click(self, event):
        """Gestisce il doppio click per editare una cella."""
        region = self.identify_region(event.x, event.y)
        if region != "cell":
            return
        
        column = self.identify_column(event.x)
        item = self.identify_row(event.y)
        
        if not item:
            return
        
        # Solo colonne Titolo (#2) e Tags (#3) sono editabili
        if column not in ('#2', '#3'):
            return
        
        self._start_edit(item, column)
    
    def _start_edit(self, item: str, column: str):
        """Inizia l'editing di una cella."""
        if self._entry:
            self._finish_edit()
        
        self._editing_item = item
        self._editing_column = column
        
        # Ottieni le coordinate della cella
        bbox = self.bbox(item, column)
        if not bbox:
            return
        
        x, y, width, height = bbox
        
        # Ottieni il valore corrente
        col_idx = int(column.replace('#', '')) - 1
        values = list(self.item(item, 'values'))
        current_value = values[col_idx] if col_idx < len(values) else ""
        
        # Crea Entry widget
        self._entry = ttk.Entry(self, width=width)
        self._entry.place(x=x, y=y, width=width, height=height)
        self._entry.insert(0, current_value)
        self._entry.select_range(0, tk.END)
        self._entry.focus_set()
        
        self._entry.bind('<Return>', lambda e: self._finish_edit())
        self._entry.bind('<FocusOut>', lambda e: self._finish_edit())
        self._entry.bind('<Escape>', self._cancel_edit)
    
    def _finish_edit(self):
        """Completa l'editing e salva il valore."""
        if not self._entry or not self._editing_item:
            return
        
        new_value = self._entry.get()
        col_idx = int(self._editing_column.replace('#', '')) - 1
        
        values = list(self.item(self._editing_item, 'values'))
        while len(values) <= col_idx:
            values.append("")
        values[col_idx] = new_value
        
        self.item(self._editing_item, values=values)
        
        self._cleanup_edit()
    
    def _cancel_edit(self, event=None):
        """Annulla l'editing."""
        self._cleanup_edit()
    
    def _cleanup_edit(self):
        """Pulisce i widget di editing."""
        if self._entry:
            self._entry.destroy()
            self._entry = None
        self._editing_item = None
        self._editing_column = None


class BulkTab(ttk.Frame):
    """Tab per l'upload bulk di video."""
    
    def __init__(self, parent, log_callback: Callable[[str], None]):
        super().__init__(parent, padding=10)
        self.log = log_callback
        self.is_processing = False
        self.should_stop = False
        self.videos: List[VideoItem] = []
        
        self._create_widgets()
    
    def _create_widgets(self):
        # === Header con info Apple Silicon ===
        header_frame = ttk.Frame(self)
        header_frame.pack(fill=tk.X, pady=(0, 10))
        
        if is_apple_silicon():
            hw_label = ttk.Label(
                header_frame, 
                text="🚀 Apple Silicon rilevato - Encoding hardware attivo",
                foreground="green"
            )
        else:
            hw_label = ttk.Label(
                header_frame, 
                text="⚙️ Encoding software (CPU)",
                foreground="gray"
            )
        hw_label.pack(side=tk.LEFT)
        
        # === Pulsanti di selezione file ===
        btn_frame = ttk.Frame(self)
        btn_frame.pack(fill=tk.X, pady=5)
        
        add_files_btn = ttk.Button(
            btn_frame, 
            text="📁 Aggiungi File",
            command=self._add_files
        )
        add_files_btn.pack(side=tk.LEFT, padx=2)
        
        add_folder_btn = ttk.Button(
            btn_frame,
            text="📂 Aggiungi Cartella",
            command=self._add_folder
        )
        add_folder_btn.pack(side=tk.LEFT, padx=2)
        
        clear_btn = ttk.Button(
            btn_frame,
            text="🗑️ Svuota Lista",
            command=self._clear_list
        )
        clear_btn.pack(side=tk.LEFT, padx=2)
        
        remove_btn = ttk.Button(
            btn_frame,
            text="❌ Rimuovi Selezionati",
            command=self._remove_selected
        )
        remove_btn.pack(side=tk.LEFT, padx=2)
        
        # === Tag Globali ===
        tags_frame = ttk.LabelFrame(self, text="Tag Globali (opzionale - si aggiungono a tutti i video)", padding=5)
        tags_frame.pack(fill=tk.X, pady=5)
        
        self.global_tags_var = tk.StringVar()
        global_tags_entry = ttk.Entry(tags_frame, textvariable=self.global_tags_var)
        global_tags_entry.pack(fill=tk.X)
        ttk.Label(tags_frame, text="Es: funny, viral, memes", foreground="gray").pack(anchor=tk.W)
        
        # === Tabella Video ===
        table_frame = ttk.LabelFrame(self, text="Video da Caricare (doppio click per modificare Titolo/Tags)", padding=5)
        table_frame.pack(fill=tk.BOTH, expand=True, pady=5)
        
        # Scrollbar
        scroll_y = ttk.Scrollbar(table_frame, orient=tk.VERTICAL)
        scroll_y.pack(side=tk.RIGHT, fill=tk.Y)
        
        scroll_x = ttk.Scrollbar(table_frame, orient=tk.HORIZONTAL)
        scroll_x.pack(side=tk.BOTTOM, fill=tk.X)
        
        # Treeview editabile
        self.tree = EditableTreeview(
            table_frame,
            columns=("file", "title", "tags", "status"),
            show="headings",
            yscrollcommand=scroll_y.set,
            xscrollcommand=scroll_x.set,
            selectmode="extended"
        )
        
        scroll_y.config(command=self.tree.yview)
        scroll_x.config(command=self.tree.xview)
        
        # Configura colonne
        self.tree.heading("file", text="📹 File")
        self.tree.heading("title", text="✏️ Titolo (doppio click)")
        self.tree.heading("tags", text="🏷️ Tags (doppio click)")
        self.tree.heading("status", text="📊 Stato")
        
        self.tree.column("file", width=200, minwidth=100)
        self.tree.column("title", width=200, minwidth=100)
        self.tree.column("tags", width=150, minwidth=80)
        self.tree.column("status", width=120, minwidth=80)
        
        self.tree.pack(fill=tk.BOTH, expand=True)
        
        # === Progress ===
        progress_frame = ttk.Frame(self)
        progress_frame.pack(fill=tk.X, pady=5)
        
        self.progress_label = ttk.Label(progress_frame, text="Pronto")
        self.progress_label.pack(side=tk.LEFT)
        
        self.progress_count = ttk.Label(progress_frame, text="")
        self.progress_count.pack(side=tk.RIGHT)
        
        self.progress_bar = ttk.Progressbar(self, mode="determinate")
        self.progress_bar.pack(fill=tk.X, pady=2)
        
        self.current_progress = ttk.Progressbar(self, mode="determinate")
        self.current_progress.pack(fill=tk.X, pady=2)
        
        # === Pulsanti azione ===
        action_frame = ttk.Frame(self)
        action_frame.pack(fill=tk.X, pady=10)
        
        self.start_btn = ttk.Button(
            action_frame,
            text="▶️ Avvia Upload",
            command=self._start_upload
        )
        self.start_btn.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=2)
        
        self.stop_btn = ttk.Button(
            action_frame,
            text="⏹️ Ferma",
            command=self._stop_upload,
            state=tk.DISABLED
        )
        self.stop_btn.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=2)
        
        self.test_btn = ttk.Button(
            action_frame,
            text="🧪 Test (Dry Run)",
            command=self._start_dry_run
        )
        self.test_btn.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=2)
    
    def _add_files(self):
        """Apre dialogo per selezionare più file."""
        filetypes = [
            ("Video", "*.mp4 *.mov *.avi *.mkv *.webm *.m4v"),
            ("Tutti i file", "*.*")
        ]
        files = filedialog.askopenfilenames(filetypes=filetypes)
        for f in files:
            self._add_video(f)
    
    def _add_folder(self):
        """Aggiunge tutti i video da una cartella."""
        folder = filedialog.askdirectory()
        if not folder:
            return
        
        video_extensions = {'.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'}
        folder_path = Path(folder)
        
        added = 0
        for f in folder_path.iterdir():
            if f.is_file() and f.suffix.lower() in video_extensions:
                self._add_video(str(f))
                added += 1
        
        if added == 0:
            messagebox.showinfo("Info", "Nessun video trovato nella cartella selezionata.")
        else:
            self.log(f"Aggiunti {added} video dalla cartella")
    
    def _add_video(self, file_path: str):
        """Aggiunge un video alla lista."""
        # Controlla se già presente
        for item in self.tree.get_children():
            if self.tree.item(item, 'values')[0] == file_path:
                return  # Già presente
        
        filename = Path(file_path).name
        title = clean_filename_to_title(filename)
        
        self.tree.insert("", tk.END, values=(file_path, title, "", "⏳ In coda"))
    
    def _clear_list(self):
        """Svuota la lista."""
        if self.is_processing:
            messagebox.showwarning("Attenzione", "Upload in corso, impossibile svuotare.")
            return
        
        for item in self.tree.get_children():
            self.tree.delete(item)
    
    def _remove_selected(self):
        """Rimuove gli elementi selezionati."""
        if self.is_processing:
            messagebox.showwarning("Attenzione", "Upload in corso, impossibile rimuovere.")
            return
        
        selected = self.tree.selection()
        for item in selected:
            self.tree.delete(item)
    
    def _get_all_items(self) -> List[tuple]:
        """Ottiene tutti gli elementi della tabella."""
        items = []
        for item_id in self.tree.get_children():
            values = self.tree.item(item_id, 'values')
            items.append((item_id, values))
        return items
    
    def _update_item_status(self, item_id: str, status: str):
        """Aggiorna lo stato di un elemento."""
        values = list(self.tree.item(item_id, 'values'))
        values[3] = status
        self.tree.item(item_id, values=values)
        self.tree.see(item_id)
    
    def _start_upload(self):
        """Avvia l'upload."""
        self._run_upload(dry_run=False)
    
    def _start_dry_run(self):
        """Avvia il test (dry run)."""
        self._run_upload(dry_run=True)
    
    def _stop_upload(self):
        """Ferma l'upload."""
        self.should_stop = True
        self.log("⏹️ Fermando l'upload...")
    
    def _run_upload(self, dry_run: bool):
        """Esegue l'upload in un thread separato."""
        items = self._get_all_items()
        
        if not items:
            messagebox.showwarning("Attenzione", "Aggiungi almeno un video alla lista.")
            return
        
        # Valida che ogni video abbia almeno un tag (global o specifico)
        global_tags = self.global_tags_var.get().strip()
        for item_id, values in items:
            file_path, title, tags, status = values
            combined_tags = ", ".join(filter(None, [global_tags, tags]))
            if not combined_tags:
                messagebox.showwarning(
                    "Attenzione", 
                    f"Il video '{Path(file_path).name}' non ha tag.\n\n"
                    "Inserisci tag globali o specifici per ogni video."
                )
                return
            if not title.strip():
                messagebox.showwarning(
                    "Attenzione",
                    f"Il video '{Path(file_path).name}' non ha un titolo."
                )
                return
        
        self.is_processing = True
        self.should_stop = False
        self.start_btn.config(state=tk.DISABLED)
        self.test_btn.config(state=tk.DISABLED)
        self.stop_btn.config(state=tk.NORMAL)
        
        thread = threading.Thread(
            target=self._process_queue,
            args=(items, dry_run),
            daemon=True
        )
        thread.start()
    
    def _process_queue(self, items: List[tuple], dry_run: bool):
        """Processa la coda di video."""
        total = len(items)
        completed = 0
        failed = 0
        global_tags = self.global_tags_var.get().strip()
        
        mode_str = "🧪 TEST" if dry_run else "🚀 UPLOAD"
        self.log(f"{mode_str} - Inizio elaborazione di {total} video...")
        
        for idx, (item_id, values) in enumerate(items):
            if self.should_stop:
                self.log("⏹️ Upload interrotto dall'utente")
                break
            
            file_path, title, tags, _ = values
            combined_tags = ", ".join(filter(None, [global_tags, tags]))
            
            # Aggiorna UI
            self.after(0, lambda: self.progress_count.config(text=f"{idx + 1}/{total}"))
            self.after(0, lambda v=(idx / total * 100): self.progress_bar.config(value=v))
            self.after(0, lambda iid=item_id: self._update_item_status(iid, "⚙️ Elaborazione..."))
            
            filename = Path(file_path).name
            self.log(f"[{idx + 1}/{total}] {filename}")
            
            def progress_cb(stage: str, percent: int):
                self.after(0, lambda s=stage, p=percent: [
                    self.progress_label.config(text=s),
                    self.current_progress.config(value=p)
                ])
            
            # Esegui ingest
            result = ingest_video(
                file_path=file_path,
                title=title.strip(),
                tags=combined_tags,
                skip_compress=False,
                dry_run=dry_run,
                progress_callback=progress_cb,
            )
            
            if result.success:
                completed += 1
                status = "✅ Completato" if not dry_run else "✅ Test OK"
                self.after(0, lambda iid=item_id, s=status: self._update_item_status(iid, s))
                self.log(f"  ✅ {filename} - OK")
            else:
                failed += 1
                error_short = result.error[:50] + "..." if len(result.error or "") > 50 else result.error
                self.after(0, lambda iid=item_id, e=error_short: self._update_item_status(iid, f"❌ {e}"))
                self.log(f"  ❌ {filename} - {result.error}")
        
        # Completa
        self.after(0, lambda: self.progress_bar.config(value=100))
        self.after(0, lambda: self.current_progress.config(value=0))
        self.after(0, lambda: self.progress_label.config(text="Completato"))
        
        summary = f"\n{'=' * 40}\n"
        summary += f"📊 RIEPILOGO\n"
        summary += f"  ✅ Completati: {completed}\n"
        summary += f"  ❌ Falliti: {failed}\n"
        summary += f"  ⏭️ Saltati: {total - completed - failed}\n"
        summary += f"{'=' * 40}"
        self.log(summary)
        
        if not dry_run and failed == 0 and completed > 0:
            self.after(0, lambda: messagebox.showinfo(
                "Successo",
                f"Tutti i {completed} video sono stati caricati con successo!"
            ))
        
        self.after(0, self._upload_finished)
    
    def _upload_finished(self):
        """Callback quando l'upload è terminato."""
        self.is_processing = False
        self.start_btn.config(state=tk.NORMAL)
        self.test_btn.config(state=tk.NORMAL)
        self.stop_btn.config(state=tk.DISABLED)


class SingleTab(ttk.Frame):
    """Tab per l'upload singolo (workflow originale)."""
    
    def __init__(self, parent, log_callback: Callable[[str], None]):
        super().__init__(parent, padding=10)
        self.log = log_callback
        self.is_uploading = False
        
        self.file_path = tk.StringVar()
        self.title_var = tk.StringVar()
        self.tags_var = tk.StringVar()
        self.skip_compress = tk.BooleanVar(value=False)
        
        self._create_widgets()
    
    def _create_widgets(self):
        # === File Video ===
        file_frame = ttk.LabelFrame(self, text="1. Seleziona Video", padding=10)
        file_frame.pack(fill=tk.X, pady=5)
        
        file_entry = ttk.Entry(file_frame, textvariable=self.file_path, state="readonly")
        file_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 10))
        
        browse_btn = ttk.Button(file_frame, text="Sfoglia...", command=self._browse_file)
        browse_btn.pack(side=tk.RIGHT)
        
        # Info video
        self.video_info_label = ttk.Label(self, text="", foreground="gray")
        self.video_info_label.pack(anchor=tk.W, pady=(5, 10))
        
        # === Titolo ===
        title_frame = ttk.LabelFrame(self, text="2. Titolo del Video", padding=10)
        title_frame.pack(fill=tk.X, pady=5)
        
        title_entry = ttk.Entry(title_frame, textvariable=self.title_var)
        title_entry.pack(fill=tk.X)
        
        # === Tags ===
        tags_frame = ttk.LabelFrame(self, text="3. Tag (separati da virgola)", padding=10)
        tags_frame.pack(fill=tk.X, pady=5)
        
        tags_entry = ttk.Entry(tags_frame, textvariable=self.tags_var)
        tags_entry.pack(fill=tk.X)
        
        ttk.Label(tags_frame, text="Esempio: vacanze, estate, mare", foreground="gray").pack(anchor=tk.W)
        
        # === Opzioni ===
        options_frame = ttk.LabelFrame(self, text="4. Opzioni", padding=10)
        options_frame.pack(fill=tk.X, pady=5)
        
        skip_check = ttk.Checkbutton(
            options_frame, 
            text="Skip compressione (usa solo se il video è già ottimizzato)",
            variable=self.skip_compress
        )
        skip_check.pack(anchor=tk.W)
        
        # === Pulsanti ===
        btn_frame = ttk.Frame(self)
        btn_frame.pack(fill=tk.X, pady=20)
        
        self.upload_btn = ttk.Button(
            btn_frame, 
            text="🚀 Carica Video",
            command=self._start_upload
        )
        self.upload_btn.pack(side=tk.LEFT, expand=True, fill=tk.X, padx=5)
        
        self.test_btn = ttk.Button(
            btn_frame,
            text="🧪 Test (Dry Run)",
            command=self._start_dry_run
        )
        self.test_btn.pack(side=tk.RIGHT, expand=True, fill=tk.X, padx=5)
        
        # === Progress ===
        self.progress_label = ttk.Label(self, text="")
        self.progress_label.pack(anchor=tk.W)
        
        self.progress = ttk.Progressbar(self, mode="determinate")
        self.progress.pack(fill=tk.X, pady=5)
    
    def _browse_file(self):
        filetypes = [
            ("Video", "*.mp4 *.mov *.avi *.mkv *.webm *.m4v"),
            ("Tutti i file", "*.*")
        ]
        path = filedialog.askopenfilename(filetypes=filetypes)
        if path:
            self.file_path.set(path)
            self._analyze_video(path)
            # Auto-genera titolo
            self.title_var.set(clean_filename_to_title(Path(path).name))
    
    def _analyze_video(self, path: str):
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
    
    def _validate(self) -> bool:
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
    
    def _start_upload(self):
        if self._validate():
            self._run_ingest(dry_run=False)
    
    def _start_dry_run(self):
        if self._validate():
            self._run_ingest(dry_run=True)
    
    def _run_ingest(self, dry_run: bool):
        if self.is_uploading:
            return
        
        self.is_uploading = True
        self.upload_btn.config(state=tk.DISABLED)
        self.test_btn.config(state=tk.DISABLED)
        
        thread = threading.Thread(target=self._do_ingest, args=(dry_run,), daemon=True)
        thread.start()
    
    def _do_ingest(self, dry_run: bool):
        try:
            mode = "🧪 TEST" if dry_run else "🚀 UPLOAD"
            self.log(f"{mode} - Inizio...")
            
            def progress_cb(stage: str, percent: int):
                self.after(0, lambda: [
                    self.progress_label.config(text=stage),
                    self.progress.config(value=percent)
                ])
            
            result = ingest_video(
                file_path=self.file_path.get(),
                title=self.title_var.get().strip(),
                tags=self.tags_var.get().strip(),
                skip_compress=self.skip_compress.get(),
                dry_run=dry_run,
                progress_callback=progress_cb,
            )
            
            if result.success:
                self.log("✅ Completato con successo!")
                if not dry_run:
                    self.after(0, lambda: messagebox.showinfo(
                        "Successo", 
                        "Video caricato con successo!\n\nOra puoi vederlo nella Mini App."
                    ))
            else:
                self.log(f"❌ Errore: {result.error}")
                self.after(0, lambda e=result.error: messagebox.showerror("Errore", e))
                
        except Exception as e:
            error_msg = str(e)
            self.log(f"❌ Errore: {error_msg}")
            self.after(0, lambda msg=error_msg: messagebox.showerror("Errore", msg))
        finally:
            self.after(0, self._upload_finished)
    
    def _upload_finished(self):
        self.is_uploading = False
        self.upload_btn.config(state=tk.NORMAL)
        self.test_btn.config(state=tk.NORMAL)
        self.progress.config(value=0)
        self.progress_label.config(text="")


class GhostStreamGUI:
    """Finestra principale con tab Singolo/Bulk."""
    
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("GhostStream Admin - Video Upload")
        self.root.geometry("800x700")
        self.root.minsize(600, 500)
        
        self._create_widgets()
    
    def _create_widgets(self):
        # Frame principale
        main = ttk.Frame(self.root, padding=10)
        main.pack(fill=tk.BOTH, expand=True)
        
        # Titolo
        header_frame = ttk.Frame(main)
        header_frame.pack(fill=tk.X, pady=(0, 10))
        
        title_label = ttk.Label(
            header_frame, 
            text="🎬 GhostStream Admin", 
            font=("Helvetica", 20, "bold")
        )
        title_label.pack(side=tk.LEFT)
        
        # === Notebook (Tab) ===
        self.notebook = ttk.Notebook(main)
        self.notebook.pack(fill=tk.BOTH, expand=True)
        
        # Tab Singolo
        self.single_tab = SingleTab(self.notebook, self._log)
        self.notebook.add(self.single_tab, text="📹 Singolo")
        
        # Tab Bulk
        self.bulk_tab = BulkTab(self.notebook, self._log)
        self.notebook.add(self.bulk_tab, text="📦 Bulk Upload")
        
        # === Log ===
        log_frame = ttk.LabelFrame(main, text="📋 Log", padding=5)
        log_frame.pack(fill=tk.BOTH, expand=False, pady=(10, 0))
        
        # Scrollbar per log
        log_scroll = ttk.Scrollbar(log_frame)
        log_scroll.pack(side=tk.RIGHT, fill=tk.Y)
        
        self.log_text = tk.Text(
            log_frame, 
            height=8, 
            state=tk.DISABLED, 
            font=("Courier", 10),
            yscrollcommand=log_scroll.set
        )
        self.log_text.pack(fill=tk.BOTH, expand=True)
        log_scroll.config(command=self.log_text.yview)
    
    def _log(self, message: str):
        """Aggiunge un messaggio al log."""
        self.log_text.config(state=tk.NORMAL)
        self.log_text.insert(tk.END, message + "\n")
        self.log_text.see(tk.END)
        self.log_text.config(state=tk.DISABLED)
        self.root.update_idletasks()


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
    
    # Stile
    style = ttk.Style()
    if "aqua" in style.theme_names():
        style.theme_use("aqua")
    elif "clam" in style.theme_names():
        style.theme_use("clam")
    
    app = GhostStreamGUI(root)
    root.mainloop()


if __name__ == "__main__":
    main()
