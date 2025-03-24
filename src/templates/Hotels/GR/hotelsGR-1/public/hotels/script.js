 
//Cookies
 $(document).ready(function() {


   // $('#newcookies').hide();

    $('.modalBtn').click(function() {
        $('#newcookies').hide()
        localStorage.setItem('checked', true)
        console.log(localStorage.getItem('checked', 'set'));
    })
    var data = localStorage.getItem('checked');
    if (!data) {
        $('#newcookies').show();
    }
});
 