var assert = require('assert');
var co = require('co');
var helper = require('./helper');
var fs = require('fs');
var jsTemplate = require('json-templater/object');
var slugid = require('slugid');

var checkMergeCommit = require('./support/check_merge_commit');
var commitContent = require('./support/commit_content');
var createBug = require('./support/create_bug');
var createPullRequest = require('./support/create_pull_request');
var branchFromRef = require('./support/branch_from_ref');
var getBugComments = require('./support/get_bug_comments');
var getCommits = require('./support/get_commits');
var reviewAttachment = require('./support/review_attachment');
var setCheckinNeeded = require('./support/set_checkin_needed');
var waitForAttachments = require('./support/wait_for_attachments');
var waitForLandingComment = require('./support/wait_for_landing_comment');
var waitForCheckinNeededRemoved = require('./support/wait_for_checkin_needed_removed');
var waitForFailedCommentInBug = require('./support/wait_for_failed_comment_in_bug');
var waitForPullState = require('./support/wait_for_pull_state');

suite('fast forward coalesce > ', function() {
  var runtime;

  suiteSetup(co(function * () {
    runtime = yield require('./support/runtime')()
    return yield helper.setup(runtime);
  }));

  suiteTeardown(co(function * () {
    return yield helper.teardown(runtime);
  }));

  test('two pull requests are coalesced into a success state, a third failed PR is not coalesced', co(function * () {
    // Make a slow taskgraph which might not even finish before the test is done.
    // The result of this one does't really matter, we just care that the success
    // case and commenting is done in the case of a coalesce.
    var taskgraphFirstSlow = fs.readFileSync(__dirname + '/fixtures/tc_success/taskgraph.json', 'utf-8');
    taskgraphFirstSlow = jsTemplate(taskgraphFirstSlow, {
      taskId: slugid.v4()
    });
    taskgraphFirstSlow = JSON.parse(taskgraphFirstSlow);
    taskgraphFirstSlow.tasks[0].task.payload.command[2] = "sleep 5m && echo \"Hello World\";"
    taskgraphFirstSlow = JSON.stringify(taskgraphFirstSlow);

    var taskgraphFastSuccess = fs.readFileSync(__dirname + '/fixtures/tc_success/taskgraph.json', 'utf-8');
    taskgraphFastSuccess = jsTemplate(taskgraphFastSuccess, {
      taskId: slugid.v4()
    });

    yield commitContent(runtime, 'master', 'taskgraph.json', taskgraphFirstSlow);
    var bug1 = yield createBug(runtime);
    var bug2 = yield createBug(runtime);
    var bug3 = yield createBug(runtime);

    // Submit the "slow" pull request.
    yield branchFromRef(runtime, 'branch1');
    yield commitContent(runtime, 'branch1', 'foo.txt', 'bar', 'Bug ' + bug1.id + ' - add foo.txt');
    var pullSlow = yield createPullRequest(runtime, 'branch1', 'master', 'Bug ' + bug1.id + ' - slow taskgraph - success to be coalesced');
    var attachments1 = yield waitForAttachments(runtime, bug1.id);
    yield reviewAttachment(runtime, attachments1[0]);
    yield setCheckinNeeded(runtime, bug1.id);

    // Wait until the "slow" pull request is in a pending state.
    yield waitForPullState(runtime, 'autolander', 'autolander-test', 'branch1', 'pending');

    // Submit the "fast" pull request for bug 2, which should pass first.
    yield branchFromRef(runtime, 'branch2');
    yield commitContent(runtime, 'branch2', 'taskgraph.json', taskgraphFastSuccess, 'Bug ' + bug2.id + ' - add fast taskgraph success');
    yield createPullRequest(runtime, 'branch2', 'master', 'Bug ' + bug2.id + ' - Autolander success taskgraph');

    // Submit the failed taskgraph for bug 3.
    yield branchFromRef(runtime, 'branch3', 'branch2');
    var taskgraphFailure = fs.readFileSync(__dirname + '/fixtures/tc_failure/taskgraph.json', 'utf-8');
    taskgraphFailure = jsTemplate(taskgraphFailure, {
      taskId: slugid.v4()
    });
    yield commitContent(runtime, 'branch3', 'taskgraph.json', taskgraphFailure, 'Bug ' + bug3.id + ' - add failure taskgraph');
    yield createPullRequest(runtime, 'branch3', 'master', 'Bug ' + bug3.id + ' - Autolander failure, should not land');

    var attachments2 = yield waitForAttachments(runtime, bug2.id);
    yield reviewAttachment(runtime, attachments2[0]);
    yield setCheckinNeeded(runtime, bug2.id);

    var attachments3 = yield waitForAttachments(runtime, bug3.id);
    yield reviewAttachment(runtime, attachments3[0]);
    yield setCheckinNeeded(runtime, bug3.id);

    // The second bug should be checked-in immediately (after the success taskgraph).
    yield waitForCheckinNeededRemoved(runtime, bug2.id);
    yield waitForLandingComment(runtime, bug2.id);

    // We should also immediately have a landing comment in bug1.
    // Note: we can't use waitFor here, otherwise we will wait until the "slow" taskgraph finishes.
    var comments = yield getBugComments(runtime, bug1.id);
    var found = false;
    for (var i = 0; i < comments.length; i++) {
      if (comments[i].text.indexOf('Pull request has landed in master') !== -1) {
        found = true;
      }
    }
    assert.equal(found, true);

    // The master branch should have five commits:
    // One original commit, and two from each branch including the merges to the integration branch.
    var commits = yield getCommits(runtime, 'autolander', 'autolander-test');
    assert.equal(commits.length, 5);
    checkMergeCommit(commits[0].commit.message, 'branch2');

    // Wait for the state of the failed taskgraph.
    yield waitForFailedCommentInBug(runtime, bug3.id);
  }));
});
