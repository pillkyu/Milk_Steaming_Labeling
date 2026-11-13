import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from serve import library,byte_range

class ViewerTests(unittest.TestCase):
    def test_ranges(self):
        self.assertEqual(byte_range('bytes=10-19',100),(10,19))
        self.assertEqual(byte_range('bytes=-10',100),(90,99))
        self.assertEqual(byte_range('bytes=10-',100),(10,99))
        for header in ['bytes=100-','bytes=20-10','bytes=-0','bytes=0-1,4-5']:
            with self.assertRaises(ValueError):byte_range(header,100)

    def test_original_offsets_and_review_states_are_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);old=root/'old';repo=root/'repo';old.mkdir();(repo/'recordings/new').mkdir(parents=True)
            (old/'audio.wav').write_bytes(b'wave');(repo/'recordings/new/original.wav').write_bytes(b'wave')
            def write(p,value):p.write_text(json.dumps(value))
            parent=dict(id='original',title='과거',duration=20,audio='audio.wav')
            parts=[dict(parent,id=f'part{i}',datasetGroup='home',parentSourceId='original',parentStart=i*10) for i in range(2)]
            write(old/'dataset.json',dict(files=parts,splitOriginals=[parent]));write(old/'labels.json',dict(classes=[],annotationOnly=[]))
            write(old/'human-reviews.json',dict(files={f'part{i}':dict(segments=[dict(start=0,end=10,label='metallic_squeal')],reviewed=i==0,excluded=False) for i in range(2)}))
            write(repo/'recordings/new/record.json',dict(source=dict(id='new',title='신규',duration=5,datasetGroup='home',originalAudio='recordings/new/original.wav'),review=dict(segments=[dict(start=0,end=5,label='non_steam',endSignal='steam_purge')],reviewed=True,excluded=True)))
            with patch('serve.subprocess.check_output',return_value='commit\n'):data,media=library(old,repo)
            self.assertEqual(len(data['files']),2)
            legacy,new=data['files'];self.assertEqual(legacy['segments'][1]['start'],10)
            self.assertEqual(legacy['segments'][1]['reviewStatus'],'미검수')
            self.assertEqual(new['status'],'사용 제외');self.assertEqual(new['segments'][0]['endSignal'],'steam_purge')
            self.assertEqual(media['local:original'],(old/'audio.wav').resolve())

if __name__=='__main__':unittest.main()
