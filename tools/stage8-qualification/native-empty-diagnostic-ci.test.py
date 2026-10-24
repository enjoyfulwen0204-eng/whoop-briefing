"""Offline control/allowlist tests only. No Git, Docker, network or native workload calls."""
import importlib.util,json,pathlib,tempfile,unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('diagnostic_control',pathlib.Path(__file__).with_name('native-empty-diagnostic-ci.py'))
control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
class DiagnosticControlTests(unittest.TestCase):
 def test_summary_is_closed_and_partial_state_ack_are_distinct(self):
  source={'observationPoint':'AFTER_AWAITED_CLEANUP','callsStarted':1,'failure':{'phase':'PRIVATE_SQL','code':'PRIVATE_CODE','frames':[{'sourceBasename':'private-user.js','line':1},{'sourceBasename':'db.js','line':12,'path':'PRIVATE_PATH'}]},'after':{'readbackStatus':'OBSERVED','execution':{'executionState':'FINALIZED_SUCCESS','resultOutcome':'PARTIAL','callAcknowledgement':'ACK_LOST'},'originalJobsCompleted':0,'jobs':[]},'telemetry':{'summary':{'outcome':'PARTIAL','query_count':4,'request_id':'PRIVATE_USER'},'totals':{'PRIVATE_OPERATION':{'count':1},'DB_HTTP':{'count':2,'raw':'PRIVATE_SQL'}}},'raw':'PRIVATE_HEALTH','attribution':{'droppedObservations':0,'droppedTransactionSamples':76,'transactionSampleCoverageComplete':False,'physicalTerminalObservationComplete':True,'terminalObservationComplete':True,'attributionComplete':False,'adapter':{'terminalComplete':True,'attributionComplete':False}}}
  summary=control.safe_summary({'status':'DIAGNOSTIC_ONLY','contract':'fixed'},source);encoded=json.dumps(summary)
  self.assertNotIn('PRIVATE',encoded);self.assertEqual(summary['callsStarted'],1);self.assertEqual(summary['after']['execution']['executionState'],'FINALIZED_SUCCESS');self.assertEqual(summary['after']['execution']['resultOutcome'],'PARTIAL');self.assertEqual(summary['after']['execution']['callAcknowledgement'],'ACK_LOST');self.assertEqual(summary['after']['originalJobsCompleted'],0);self.assertEqual(summary['failure']['frames'],[{'sourceBasename':'db.js','line':12}]);self.assertEqual(summary['telemetry']['summary']['query_count'],4);self.assertEqual(summary['attribution']['droppedTransactionSamples'],76);self.assertIs(summary['attribution']['transactionSampleCoverageComplete'],False);self.assertIs(summary['attribution']['physicalTerminalObservationComplete'],True);self.assertIs(summary['attribution']['attributionComplete'],False);self.assertIs(summary['attribution']['adapter']['terminalComplete'],True);self.assertIs(summary['attribution']['adapter']['attributionComplete'],False)
 def test_unfinalized_report_does_not_claim_known_call_count(self):
  summary=control.safe_summary({}, {'observationPoint':'BEFORE_ORIGINAL_INVOCATION','callsStarted':0,'ownedCleanupEligible':True})
  self.assertIsNone(summary['callsStarted']);self.assertFalse(summary['capacityQualified'])
 def test_running_owned_runtime_is_never_force_removed(self):
  cid='a'*64;candidate='b'*40;name='stage6-diagnostic-test'
  with tempfile.TemporaryDirectory() as temp:
   sandbox=pathlib.Path(temp);(sandbox/'container.cid').write_text(cid);(sandbox/'owned-runtime-state.json').write_text(json.dumps({'name':name,'candidateSha':candidate,'imageId':'image-pinned'}))
   calls=[]
   def fake_run(args,seconds=10):
    calls.append(args)
    if args[1:3]==['container','inspect']:return json.dumps([{'Id':cid,'Name':'/'+name,'Image':'image-pinned','Config':{'Labels':{'healthos.stage6.native-diagnostic':name}},'State':{'Running':True}}])
    return cid
   with patch.dict(control.os.environ,{'CANDIDATE_SHA':candidate}),patch.object(control,'run',fake_run),patch.object(control.subprocess,'run',side_effect=AssertionError('NO_MUTATION_ALLOWED')):
    with self.assertRaisesRegex(AssertionError,'NO_FORCE_REMOVAL'):control.owned_cleanup(sandbox,name)
   self.assertTrue(all('rm' not in args for args in calls))
if __name__=='__main__':unittest.main(verbosity=2)
