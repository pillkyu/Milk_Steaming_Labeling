import unittest
import numpy as np
from pipeline import assign_folds,phase_fp

class PipelineTests(unittest.TestCase):
    def test_original_and_session_grouping(self):
        rows=[dict(id='old',pcmSHA256='1',fold=3),dict(id='a',pcmSHA256='2',sessionGroup='day1'),dict(id='b',pcmSHA256='3',sessionGroup='day1')]
        result=assign_folds(rows)
        self.assertEqual(result[0]['fold'],3)
        self.assertEqual(result[1]['fold'],result[2]['fold'])
        with self.assertRaises(ValueError):assign_folds([dict(id='a',pcmSHA256='same'),dict(id='b',pcmSHA256='same')])
        with self.assertRaises(ValueError):assign_folds([dict(id='a',pcmSHA256='a',sessionGroup='x',fold=0),dict(id='b',pcmSHA256='b',sessionGroup='x',fold=1)])

    def test_unknown_and_boiling_are_not_negative_ground_truth(self):
        source={'segments':[dict(start=0,end=1,label='normal_air'),dict(start=1,end=2,label='unknown'),
                            dict(start=2,end=3,label='non_steam'),dict(start=3,end=4,label='excess_bubbling')]}
        result=phase_fp(source,{'raw':[0]*370})['normal_air']
        t=(2048+512*np.arange(370))/48000
        self.assertEqual(result['tp'],np.sum(t<1))
        self.assertEqual(result['fp'],np.sum((t>=2+2048/48000)&(t<3)))
        self.assertEqual(result['falseEpisodes'],1)
        self.assertEqual(result['fn'],0)

if __name__=='__main__':unittest.main()
