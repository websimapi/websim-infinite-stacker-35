import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { setupScene } from './setup.js';
import { UIManager } from './ui.js';
import { Game } from './game.js';
import { ReplayRecorder } from './replay.js';
import { CanvasUI } from './canvas-ui.js';
import { AudioManager } from './audio.js';
import * as ScoreStorage from './score-storage.js';

// Global state
let game, ui, canvasUI, audioManager;
let scene, world, camera, renderer, uiScene, uiCamera, sky;
let skyScene, skyCamera;
let pendingSubmissions = []; // Track background submissions
let currentUser = null;
let currentUserHighScore = null;

const room = new WebsimSocket();
const LEADERBOARD_MAX_SIZE = 1000;

async function init() {
    const {
        scene: s,
        world: w,
        camera: c,
        renderer: r,
        defaultMaterial: dm,
        uiScene: us,
        uiCamera: uc,
        sky: skyInstance,
        skyScene: ss,
        skyCamera: sc
    } = setupScene();
    scene = s;
    world = w;
    camera = c;
    renderer = r;
    uiScene = us;
    uiCamera = uc;
    sky = skyInstance;
    skyScene = ss;
    skyCamera = sc;

    ui = new UIManager();
    canvasUI = new CanvasUI(uiScene);
    audioManager = new AudioManager();
    audioManager.loadSound('place', 'block_place.mp3');
    audioManager.loadSound('fail', 'fail_sound.mp3');

    window.websim.getCurrentUser().then(user => {
        currentUser = user;
        if (user) {
            const scores = room.collection('score_v1').getList();
            const userScores = scores.filter(score => score.username === user.username);
            currentUserHighScore = userScores.sort((a, b) => b.score - a.score)[0] || null;
        }
        syncLocalScores();
    });

    const gameCallbacks = {
        onScoreUpdate: (score) => {
            ui.updateScore(score);
            canvasUI.updateScore(score);
        },
        onStreakUpdate: (count, isGolden, isPerfectHit) => {
            ui.updateStreak(count, isGolden, isPerfectHit);
        },
        onGameOver: (score) => {
            const endedGameSession = {
                score,
                replayRecorder: game.getReplayRecorder(),
            };
            
            // Stop the recorder immediately to finalize the video
            endedGameSession.replayRecorder?.stop();

            ui.showGameOver(score);
            ui.setReplayButtonState(true, 'Preparing...');
            
            handleFinishedGame(endedGameSession);
        }
    };

    game = new Game(scene, world, dm, camera, gameCallbacks, audioManager);
    
    setupEventListeners();
    
    // Subscribe to all scores for the public leaderboard
    room.collection('score_v1').subscribe(scores => {
        const sortedScores = scores.sort((a, b) => b.score - a.score);
        ui.updateLeaderboard(sortedScores, (replayUrl) => {
            ui.showReplayViewer(replayUrl);
        });

        if (currentUser) {
            const userScores = scores.filter(score => score.username === currentUser.username);
            currentUserHighScore = userScores.sort((a, b) => b.score - a.score)[0] || null;
        }
    });

    renderer.setAnimationLoop(animate);
    startGame();
}

function startGame() {
    const newReplayRecorder = new ReplayRecorder(renderer.domElement, audioManager);
    game.start(newReplayRecorder);
    ui.hideGameOver();
    ui.showInstructions(true);
    canvasUI.updateScore(0);
}

function restart() {
    game.restart();
    startGame();
}

async function handleFinishedGame(session) {
    const { score, replayRecorder } = session;
    if (!replayRecorder) {
        autoSubmitScore(null, score, false);
        return;
    }

    const replayBlobPromise = replayRecorder.getReplayBlob();

    replayBlobPromise.then(blob => {
        ui.setReplayButtonState(false, 'Watch Replay', blob);
        autoSubmitScore(blob, score, true);
    }).catch(error => {
        console.error("Error getting replay blob:", error);
        ui.setReplayButtonState(false, 'Replay Failed');
        autoSubmitScore(null, score, false);
    });
}


async function autoSubmitScore(replayBlob, scoreToSubmit, hasReplay, localTempId = null) {
    if (hasReplay && (!replayBlob || replayBlob.size === 0) && !localTempId) {
        console.warn("Auto-submit cancelled: replay blob is invalid.");
        if (!ui.gameOverElement.classList.contains('hidden')) {
            ui.setSubmitStatus('Replay failed. Score not submitted.', '#f44336');
        }
        return;
    }

    const isResubmission = !!localTempId;
    let tempId = localTempId;

    if (!isResubmission && currentUser) {
        tempId = ScoreStorage.saveUserScore(currentUser.username, {
            score: scoreToSubmit,
            replayUrl: null,
            timestamp: Date.now()
        });
    }

    // Add visual indicator to trophy button
    const leaderboardButton = document.getElementById('leaderboard-button');
    leaderboardButton.classList.add('uploading');
    leaderboardButton.textContent = '⏳';

    const submissionPromise = (async () => {
        let isScoreSubmitted = false;
        try {
            const userForSubmission = currentUser || await window.websim.getCurrentUser();
            if (!userForSubmission) {
                throw new Error('Could not get user info for submission.');
            }
            if (!currentUser) currentUser = userForSubmission;

            const allScores = room.collection('score_v1').getList();
            
            // --- Leaderboard Cap Logic ---
            if (allScores.length >= LEADERBOARD_MAX_SIZE) {
                const lowestScore = allScores.reduce((min, s) => s.score < min ? s.score : min, Infinity);
                if (scoreToSubmit <= lowestScore) {
                    console.log('Score too low for full leaderboard.');
                    if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                        ui.setSubmitStatus(`Score must be > ${lowestScore} to make the leaderboard.`, '#ff9800');
                    }
                    if (tempId) ScoreStorage.removeUserScore(currentUser.username, tempId);
                    return;
                }
            }

            const userHighScoreRecord = currentUserHighScore;

            // Clean up duplicate scores if they exist
            const userScores = allScores.filter(score => score.username === userForSubmission.username);
            if (userScores.length > 1) {
                const highestScore = userScores.sort((a, b) => b.score - a.score)[0];
                const scoresToDelete = userScores.filter(s => s.id !== highestScore.id);
                for (const scoreRecord of scoresToDelete) {
                    console.log(`Cleaning up old score for ${userForSubmission.username}: ${scoreRecord.score}`);
                    room.collection('score_v1').delete(scoreRecord.id);
                }
            }

            // If the user has a score and the new one isn't higher, stop.
            if (userHighScoreRecord && scoreToSubmit <= userHighScoreRecord.score && !isResubmission) {
                console.log('Score not higher than user\'s best.');
                if (!ui.gameOverElement.classList.contains('hidden')) {
                    ui.setSubmitStatus('Not a new high score.', '#ff9800');
                }
                if (tempId) ScoreStorage.removeUserScore(currentUser.username, tempId);
                return;
            }
            
            let replayUrl = null;
            if (hasReplay && replayBlob) {
                try {
                    replayUrl = await window.websim.upload(replayBlob);
                    if (!replayUrl) throw new Error('Upload returned invalid URL');
                    
                    const response = await fetch(replayUrl, { method: 'HEAD' });
                    if (!response.ok) throw new Error('Uploaded file not accessible');
                    if (tempId) ScoreStorage.updateUserScore(currentUser.username, tempId, { replayUrl });

                } catch (uploadError) {
                    console.error("Replay upload failed:", uploadError);
                     if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                        ui.setSubmitStatus('Replay upload failed. Score not submitted.', '#f44336');
                    }
                    if (tempId) ScoreStorage.removeUserScore(currentUser.username, tempId);
                    return; 
                }
            } else if (isResubmission) {
                const localData = ScoreStorage.getUserScores(currentUser.username).find(s => s.tempId === tempId);
                if (localData && localData.replayUrl) {
                    replayUrl = localData.replayUrl;
                }
            }

            if (hasReplay && !replayUrl && !isResubmission) {
                console.error('Replay upload seems to have failed silently.');
                if (!ui.gameOverElement.classList.contains('hidden')) {
                    ui.setSubmitStatus('Replay upload incomplete. Score not submitted.', '#f44336');
                }
                if (tempId) ScoreStorage.removeUserScore(currentUser.username, tempId);
                return;
            }

            if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                 ui.setSubmitStatus('Saving high score...', '#ff9800');
            }

            const scoreData = { score: scoreToSubmit };
            if (replayUrl) {
                scoreData.replayUrl = replayUrl;
            }

            if (userHighScoreRecord) {
                await room.collection('score_v1').update(userHighScoreRecord.id, scoreData);
                if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                    ui.setSubmitStatus('High score updated!', '#4CAF50');
                }
            } else {
                await room.collection('score_v1').create(scoreData);
                if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                    ui.setSubmitStatus('High score submitted!', '#4CAF50');
                }
            }
            isScoreSubmitted = true;
            if (tempId) ScoreStorage.removeUserScore(currentUser.username, tempId);

        } catch (error) {
            console.error("Failed to auto-submit score:", error);
            if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                ui.setSubmitStatus('Error submitting score.', '#f44336');
            }
        } finally {
            if (isScoreSubmitted) {
                leaderboardButton.classList.remove('uploading');
                leaderboardButton.classList.add('upload-complete');
                leaderboardButton.textContent = '✅';
                
                setTimeout(() => {
                    leaderboardButton.classList.remove('upload-complete');
                    leaderboardButton.textContent = '🏆';
                }, 3000);
            } else {
                 leaderboardButton.classList.remove('uploading');
                 leaderboardButton.textContent = '🏆';
            }
        }
    })();

    pendingSubmissions.push(submissionPromise);
    submissionPromise.finally(() => {
        const index = pendingSubmissions.indexOf(submissionPromise);
        if (index > -1) {
            pendingSubmissions.splice(index, 1);
        }
    });
}

async function syncLocalScores() {
    if (!currentUser) return;

    const localScores = ScoreStorage.getUserScores(currentUser.username);
    if (localScores.length === 0) return;

    console.log(`Found ${localScores.length} local scores to check.`);

    const dbScores = room.collection('score_v1').getList();
    const userDbScores = dbScores.filter(s => s.username === currentUser.username);

    for (const localScore of localScores) {
        // A simple check: if a score with the exact value and replay URL exists, assume it's synced.
        const isSynced = userDbScores.some(dbScore =>
            dbScore.score === localScore.score &&
            (!localScore.replayUrl || dbScore.replayUrl === localScore.replayUrl)
        );

        if (!isSynced) {
            console.log(`Resubmitting local score: ${localScore.score}`);
            // Resubmit. This uses the autoSubmit logic which includes all checks.
            // We pass null for the blob because we can't store it, but we have the URL.
            const hasReplay = !!localScore.replayUrl;
            autoSubmitScore(null, localScore.score, hasReplay, localScore.tempId);
        } else {
            // It's on the server, so we can clean it up locally.
            ScoreStorage.removeUserScore(currentUser.username, localScore.tempId);
        }
    }
}

async function viewReplay() {
    const blob = ui.getCurrentReplayBlob();
    if (!blob) {
        alert("Replay not available or still processing.");
        return;
    }

    ui.setReplayButtonState(true, 'Loading...');
    try {
        ui.showReplayViewer(blob);
    } catch (error) {
        console.error("Error viewing replay:", error);
        alert("Could not load replay.");
    } finally {
        ui.setReplayButtonState(false, 'Watch Replay', blob);
    }
}

async function submitScore() {
    // This function is no longer used and can be removed or left empty.
    // For safety, we'll just log that it was called.
    console.log("submitScore called, but functionality is now in autoSubmitScore.");
}

function setupEventListeners() {
    ui.setupEventListeners({
        onPointerDown: () => {
            audioManager.unlockAudio();
            if (game.getState() === 'playing') {
                ui.showInstructions(false);
                game.onPointerDown();
            }
        },
        onRestart: restart,
        onViewReplay: viewReplay,
        onViewLeaderboard: () => ui.showLeaderboard(),
        onCloseLeaderboard: () => {
            ui.hideLeaderboard();
            const gameState = game.getState();
            if (gameState === 'gameover') {
                ui.showGameOver(game.getScore());
            } else if (gameState !== 'playing') {
                restart();
            }
            // If game is 'playing', do nothing extra, just hide the leaderboard.
        },
        onWindowResize: () => {
            const aspect = window.innerWidth / window.innerHeight;
            const frustumSize = 4;
            camera.left = frustumSize * aspect / -2;
            camera.right = frustumSize * aspect / 2;
            camera.top = frustumSize / 2;
            camera.bottom = frustumSize / -2;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);

            uiCamera.left = -window.innerWidth / 2;
            uiCamera.right = window.innerWidth / 2;
            uiCamera.top = window.innerHeight / 2;
            uiCamera.bottom = -window.innerHeight / 2;
            uiCamera.updateProjectionMatrix();
            canvasUI.onWindowResize();
        }
    });

    window.addEventListener('beforeunload', (event) => {
        if (pendingSubmissions.length > 0) {
            event.preventDefault();
            event.returnValue = ''; // For Chrome
            return "Your score is still uploading. Are you sure you want to leave?"; // For older browsers
        }
    });
}

function animate() {
    world.step(1 / 60);
    game.update();
    sky.update();
    
    renderer.clear();

    // Render sky first with its own camera
    renderer.render(skyScene, skyCamera);

    // Render game scene
    renderer.render(scene, camera);

    renderer.clearDepth();
    renderer.render(uiScene, uiCamera);
}

init();