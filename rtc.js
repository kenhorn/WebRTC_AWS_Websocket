
    const hash = location.hash.length == 0 ? {}: location.hash.substring(1).split("&").reduce((hash,kv)=>{bits=kv.split("=");hash[bits[0]]=bits[1];return hash;}, {})

    const webSocketConnection = hash.url;
    const turnServerIPAddress = hash.ip;
    const turnServerPort      = hash.port;
    const turnServerUserName  = hash.username;
    const turnServerPassword  = hash.password;

    var cameraMode = "environment";

    existingTracks = [];

    var socket, localStream, connection, clientId = uuidv4(), channel;

    const configuration = {
      iceServers: [
            {
                urls: 'stun:' + turnServerIPAddress + ':' + turnServerPort
            },
            {
                urls: 'turn:' + turnServerIPAddress + ':' + turnServerPort,
                username: turnServerUserName,
                credential: turnServerPassword
            }
      ]
    }

    disableAllButtons();
    
    getLocalWebCamFeed();


    /*
        This function creates the socket connection and WebRTC connection. 
        This is also responsible for changing media tracks when user switches mobile cameras (Front and back)
    */
    function initiatSocketAndPeerConnection(stream){
        document.getElementById("localVideo").srcObject = stream;

        if(typeof socket === 'undefined'){
            connectToWebSocket();
        }else{
            existingTracks.forEach(function (existingTrack, index) {
                existingTrack.replaceTrack(localStream.getTracks()[index]);
            });
        }
    }

    function disableAllButtons(){
        document.getElementById("sendOfferButton").disabled = true;
        document.getElementById("answerButton").disabled = true;
        document.getElementById("sendMessageButton").disabled = true;
        document.getElementById("hangUpButton").disabled = true;
    }

    /*
        Send messages via Data Channel
    */
    function sendMessage(){
        var messageText = document.getElementById("messageInput").value; 

        channel.send(JSON.stringify({
            "message": messageText
        }));

        document.getElementById("chatTextArea").value += messageText + '\n';
    }

    function disconnectRTCPeerConnection(){
        connection.close();
    }

    /*
        Connect to the web socket and handle recieved messages from web sockets
    */
    function connectToWebSocket(){
        socket = new WebSocket(webSocketConnection);

        // Create WebRTC connection only if the socket connection is successful.
        socket.onopen = function(event) {
            log('WebSocket Connection Open.');
            createRTCPeerConnection();
        };

        // Handle messages recieved in socket
        socket.onmessage = function(event) {
            jsonData = JSON.parse(event.data);

            switch (jsonData.type){
                case 'candidate':
                    handleCandidate(jsonData.data, jsonData.id);
                    break;
                case 'offer':
                    handleOffer(jsonData.data, jsonData.id);
                    break;
                case 'answer':
                    handleAnswer(jsonData.data, jsonData.id);
                    break;
                default:
                    break
            }
        };

        socket.onerror = function(event) {
            console.error(event);
            log('WebSocket Connection Error. Make sure web socket URL is correct and web socket server is up and running at - ' + webSocketConnection);
        };

        socket.onclose = function(event) {
            log('WebSocket Connection Closed. Please Reload the page.');
            document.getElementById("sendOfferButton").disabled = true;
            document.getElementById("answerButton").disabled = true;
        };
    }

    function log(message){
        document.getElementById("logs").value += message + '\n';
    }

    /*
        Get local camera permission from user and initiate socket and WebRTC connection
    */
    function getLocalWebCamFeed(){
        constraints = {
            audio: true,
            video: {
                facingMode: cameraMode
            }
        } 

        navigator.getWebcam = (navigator.getUserMedia || navigator.webKitGetUserMedia || navigator.moxGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia);
        if (navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia(constraints)
            .then(function (stream) {
                localStream = stream;
                initiatSocketAndPeerConnection(stream);
            })
            .catch(function (e) { log(e.name + ": " + e.message); });
        }
        else {
            navigator.getWebcam({ audio: true, video: true }, 
                function (stream) {
                    localStream = stream;
                    initiatSocketAndPeerConnection(stream);
                }, 
                function () { log("Web cam is not accessible."); 
            });
        }
    }

    /*
        This is responsible for creating an RTCPeerConnection and handle it's events.
    */
    function createRTCPeerConnection(){
        connection = new RTCPeerConnection(configuration);

        // Add both video and audio tracks to the connection
        for (const track of localStream.getTracks()) {
            log("Sending Stream.")
            existingTracks.push(connection.addTrack(track, localStream));
        }

        // This event handles displaying remote video and audio feed from the other peer
        connection.ontrack = event => {
            log("Recieved Stream.");
            document.getElementById("remoteVideo").srcObject = event.streams[0];
        }

        // This event handles the received data channel from the other peer
        connection.ondatachannel = function (event) {
            log("Recieved a DataChannel.")
            channel = event.channel;
            setChannelEvents(channel);
            document.getElementById("sendMessageButton").disabled = false;
        };

        // This event sends the ice candidates generated from Stun or Turn server to the Receiver over web socket
        connection.onicecandidate = event => {
            if (event.candidate) {
                log("Sending Ice Candidate - " + event.candidate.candidate);

                socket.send(JSON.stringify(
                    {
                        action: 'onMessage',
                        type: 'candidate',
                        data: event.candidate,
                        id: clientId
                    }
                ));
            }
        }

        // This event logs messages and handles button state according to WebRTC connection state changes
        connection.onconnectionstatechange = function(event) {
            switch(connection.connectionState) {
                case "connected":
                    log("Web RTC Peer Connection Connected.");
                    document.getElementById("answerButton").disabled = true;
                    document.getElementById("sendOfferButton").disabled = true;
                    document.getElementById("hangUpButton").disabled = false;
                    document.getElementById("sendMessageButton").disabled = false;
                    break;
                case "disconnected":
                    log("Web RTC Peer Connection Disconnected. Please reload the page to reconnect.");
                    disableAllButtons();
                    break;
                case "failed":
                    log("Web RTC Peer Connection Failed. Please reload the page to reconnect.");
                    console.log(event);
                    disableAllButtons();
                    break;
                case "closed":
                    log("Web RTC Peer Connection Failed. Please reload the page to reconnect.");
                    disableAllButtons();
                    break;
                default:
                    break;
            }
        }

        log("Web RTC Peer Connection Created.");
        document.getElementById("sendOfferButton").disabled = false;
    }

    /*
        Creates and sends the Offer to the Receiver
        Creates a Data channel for exchanging text messages
        This function is invoked by the Caller
    */
    function createAndSendOffer(){
        if(channel){
            channel.close();
        }

        // Create Data channel
        channel = connection.createDataChannel('channel', {});
        setChannelEvents(channel);

        // Create Offer
        connection.createOffer().then(
            offer => {
                log('Sent The Offer.');

                // Send Offer to other peer
                socket.send(JSON.stringify(
                    {
                        action: 'onMessage',
                        type: 'offer',
                        data: offer,
                        id: clientId
                    }
                ));

                // Set Offer for negotiation
                connection.setLocalDescription(offer);
            },
            error => {
                log('Error when creating an offer.');
                console.error(error);
            }
        );
    }

    /*
        Creates and sends the Answer to the Caller
        This function is invoked by the Receiver
    */
    function createAndSendAnswer(){

        // Create Answer
        connection.createAnswer().then(
            answer => {
                log('Sent The Answer.');

                // Set Answer for negotiation
                connection.setLocalDescription(answer);

                // Send Answer to other peer
                socket.send(JSON.stringify(
                    {
                        action: 'onMessage',
                        type: 'answer',
                        data: answer,
                        id: clientId
                    }
                ));
            },
            error => {
                log('Error when creating an answer.');
                console.error(error);
            }
        );
    }

    /*
        Accepts ICE candidates received from the Caller
    */
    function handleCandidate(candidate, id){

        // Avoid accepting the ice candidate if this is a message created by the current peer
        if(clientId != id){
            log("Adding Ice Candidate - " + candidate.candidate);
            connection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    }
    
    /*
        Accepts Offer received from the Caller
    */
    function handleOffer(offer, id){

        // Avoid accepting the Offer if this is a message created by the current peer
        if(clientId != id){
            log("Recieved The Offer.");
            connection.setRemoteDescription(new RTCSessionDescription(offer));
            document.getElementById("answerButton").disabled = false;
            document.getElementById("sendOfferButton").disabled = true;
        }
    }

    /*
        Accetps Answer received from the Receiver
    */
    function handleAnswer(answer, id){

        // Avoid accepting the Answer if this is a message created by the current peer
        if(clientId != id){
            log("Recieved The Answer");
            connection.setRemoteDescription(new RTCSessionDescription(answer));
        }
    }
    
    /*
        Generate a unique ID for the peer
    */
    function uuidv4() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /*
        Handle Data Channel events
    */
    function setChannelEvents(channel) {
        channel.onmessage = function (event) {
            var data = JSON.parse(event.data);
            document.getElementById("chatTextArea").value += data.message + '\n';
        };

        channel.onerror = function (event) {
            log('DataChannel Error.');
            console.error(event)
        };

        channel.onclose = function (event) {
            log('DataChannel Closed.');
            disableAllButtons();
        };
    }

    /*
        Switch between front and back camera when opened in a mobile browser
    */
    function switchMobileCamera(){
        if (cameraMode == "user") {
            cameraMode = "environment";
        } else {
            cameraMode = "user";
        }

        getLocalWebCamFeed();
    }
